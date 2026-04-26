/**
 * memory.search v7.0 — File-based Runbook Search with Intelligence Layer
 * Query expansion + reranking + target-tag boost + credential priority
 * @module mcp/tools/memory.search
 */
import { searchRunbooks } from '../../storage/files.js';
import { vectorSearchRunbooks, isVectorReady } from '../../storage/vectorIndex.js';
import { queryGraph, findRelatedEntities, getEntityStats } from '../../storage/graphIndex.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger.js';

/**
 * Common technique words excluded from target-tag boost
 * These are NOT target identifiers (domains, hosts, services)
 */
const COMMON_TECHNIQUE_WORDS = new Set([
    'exploit', 'vulnerability', 'payload', 'attack', 'hack', 'shell', 'webshell',
    'rce', 'xxe', 'sqli', 'xss', 'ssrf', 'lfi', 'rfi', 'ssti', 'idor', 'csrf',
    'injection', 'bypass', 'brute', 'force', 'enum', 'enumeration', 'scan',
    'credential', 'creds', 'password', 'tunnel', 'persistence', 'backdoor', 'reverse',
    'ssh', 'rdp', 'ftp', 'http', 'https', 'mysql', 'redis', 'smb',
    'port', 'proxy', 'socks', 'chisel', 'ngrok', 'cloudflare',
    'recon', 'install', 'deploy', 'upload', 'download', 'exfil',
    'access', 'login', 'connect', 'pivot', 'escalate', 'privesc', 'dump',
    'failed', 'success', 'blocked', 'patched', 'active', 'gagal', 'berhasil',
    'full', 'updated', 'server', 'target', 'host', 'domain', 'windows', 'linux',
    'tier', 'phase', 'chain', 'teknik', 'technique', 'runbook', 'universal',
    'root', 'admin', 'sudo', 'cve', 'poc', 'exploit'
]);

/**
 * Rerank results with target-tag relevance boost
 * @param {Array} results - Search results from searchRunbooks
 * @param {string} originalQuery - Original user query (before expansion)
 * @returns {Array} Reranked results
 */
function rerankResults(results, originalQuery) {
    const queryWords = (originalQuery || '').toLowerCase().split(/\s+/).filter(w => w.length >= 2);
    if (queryWords.length === 0) return results;

    // v7.3: Dedup by ID — keep highest-scoring entry per file
    const seen = new Map();
    for (const item of results) {
        const key = item.id || item.title;
        if (!seen.has(key) || (item.score || 0) > (seen.get(key).score || 0)) {
            seen.set(key, item);
        }
    }
    results = [...seen.values()];

    // Extract target keywords (domain-like, not common technique words)
    const targetKeywords = queryWords.filter(k => !COMMON_TECHNIQUE_WORDS.has(k) && k.length >= 3);

    return results.map(item => {
        let score = item.score || 0;

        // TARGET-TAG BOOST: Items with matching target tags get priority
        if (targetKeywords.length > 0) {
            const itemTags = (item.tags || []).map(t => (t || '').toLowerCase());
            const tagMatches = targetKeywords.filter(tk => itemTags.some(t => t.includes(tk))).length;
            if (tagMatches > 0) {
                // 20% boost per matching target keyword, capped at 50%
                const boost = Math.min(0.5, tagMatches * 0.2);
                score *= (1 + boost);
            }

            // TITLE TARGET BOOST: Title containing target name gets extra priority
            const titleLower = (item.title || '').toLowerCase();
            const titleTargetMatches = targetKeywords.filter(tk => titleLower.includes(tk)).length;
            if (titleTargetMatches > 0) {
                score *= (1 + titleTargetMatches * 0.15);
            }
        }

        // ERROR PENALTY: Items with known failures score lower
        const snippetLower = (item.snippet || '').toLowerCase();
        if (snippetLower.includes('gagal') || snippetLower.includes('failed') || snippetLower.includes('blocked')) {
            // Only penalize if query is NOT specifically searching for failures
            if (!queryWords.some(w => ['gagal', 'failed', 'error', 'blocked'].includes(w))) {
                score *= 0.85;
            }
        }

        return { ...item, score: Math.round(score * 100) / 100 };
    }).sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (b.updated_at || '').localeCompare(a.updated_at || '');
    });
}

/**
 * v7.5: Reciprocal Rank Fusion — merge FTS5 + vector results
 * RRF score = sum(1 / (k + rank)) for each list the doc appears in
 * @param {Array} ftsResults - FTS5 BM25 results (already ranked)
 * @param {Array} vectorResults - Vector similarity results [{id, similarity}]
 * @param {number} k - RRF constant (default 60)
 * @returns {Array} Merged results with rrf_score
 */
function rrfMerge(ftsResults, vectorResults, k = 60) {
    const scores = new Map();
    const itemData = new Map();

    // FTS5 ranks
    for (let i = 0; i < ftsResults.length; i++) {
        const id = ftsResults[i].id;
        scores.set(id, (scores.get(id) || 0) + 1 / (k + i + 1));
        itemData.set(id, ftsResults[i]);
    }

    // Vector ranks
    for (let i = 0; i < vectorResults.length; i++) {
        const id = vectorResults[i].id;
        scores.set(id, (scores.get(id) || 0) + 1 / (k + i + 1));
        // Only set itemData if not already from FTS (FTS has richer data)
        if (!itemData.has(id)) {
            itemData.set(id, { id, score: 0, vector_similarity: vectorResults[i].similarity });
        } else {
            itemData.get(id).vector_similarity = vectorResults[i].similarity;
        }
    }

    // Build merged result sorted by RRF score
    const merged = [];
    for (const [id, rrfScore] of scores) {
        const item = itemData.get(id);
        merged.push({ ...item, score: rrfScore * 100, rrf_score: rrfScore });
    }
    merged.sort((a, b) => b.rrf_score - a.rrf_score);
    return merged;
}

export const definition = {
    name: 'memory_search',
    description: 'Cari runbook — returns compact index (ID + title + score + 1-line snippet). Gunakan memory_get({id:"..."}) untuk baca full content. DILARANG full_content:true.',
    inputSchema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Search query' },
            project_id: { type: 'string', description: 'Project ID' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags (OR logic)' },
            required_tags: { type: 'array', items: { type: 'string' }, description: 'Mandatory tags (AND logic)' },
            limit: { type: 'number', description: 'Max results (default: 20)' },
            offset: { type: 'number', description: 'Offset for pagination (default: 0)' },
            full_content: { type: 'boolean', description: 'Return full content instead of snippet (default: false)' },
            scope_id: { type: 'string', description: 'Scope search to ONE specific runbook file' },
            types: { type: 'array', items: { type: 'string' }, description: 'Ignored — all items are runbooks' },
            override_quarantine: { type: 'boolean', description: 'Ignored — no quarantine in file mode' },
            allow_relations: { type: 'boolean', description: 'Ignored — no graph in file mode' }
        },
        required: ['query', 'project_id']
    }
};

export async function execute(params) {
    const traceId = uuidv4();
    const {
        query: searchQuery,
        tags = [],
        required_tags: requiredTags = [],
        limit: rawLimit = 20,
        offset = 0,
        full_content: rawFullContent = false,
        scope_id: scopeId = ''
    } = params;

    const fullContent = false;
    const limit = Math.min(rawLimit, 20);

    try {
        // v7.0: Get more results for reranking, then apply post-processing
        const fetchLimit = Math.min(limit * 2, 50);
        const { results: rawResults, pagination: rawPagination } = searchRunbooks(searchQuery, {
            tags,
            requiredTags,
            limit: fetchLimit,
            offset: 0,  // Always fetch from 0 for reranking
            fullContent,
            scopeId
        });

        // v7.5: Run vector search in parallel (async) — additive, not replacing FTS5
        let vectorResults = [];
        let vectorUsed = false;
        if (isVectorReady()) {
            try {
                vectorResults = await vectorSearchRunbooks(searchQuery, fetchLimit);
                vectorUsed = vectorResults.length > 0;
            } catch (err) {
                logger.warn('Vector search failed in memory_search (non-fatal)', { error: err.message });
            }
        }

        // v7.5: RRF merge if vector results available, else use FTS5 only
        let mergedResults;
        if (vectorUsed && vectorResults.length > 0) {
            mergedResults = rrfMerge(rawResults, vectorResults);
        } else {
            mergedResults = rawResults;
        }

        // v7.0: Apply reranking with target-tag boost
        const reranked = rerankResults(mergedResults, searchQuery);

        // v7.5: Graph enrichment — add related entities to results
        for (const item of reranked) {
            try {
                const related = findRelatedEntities(item.id, 5);
                if (related.length > 0) {
                    item.related_entities = related.map(r => r.name).slice(0, 5);
                }
            } catch {}
        }

        // Apply pagination AFTER reranking
        const paginated = reranked.slice(offset, offset + limit);
        const total = reranked.length;

        const compactResults = paginated.map(item => {
            const compact = {
                id: item.id,
                score: item.score,
                vector_similarity: item.vector_similarity,
                rrf_score: item.rrf_score
            };
            if (item.title) compact.title = item.title;
            if (item.content_length) compact.content_length = item.content_length;
            if (item.tags) compact.tags = item.tags;
            if (item.created_at) compact.created_at = item.created_at;
            if (item.updated_at) compact.updated_at = item.updated_at;
            if (item.version) compact.version = item.version;
            if (item.snippet) {
                compact.snippet = item.snippet.length > 500 ? item.snippet.substring(0, 500) + '...' : item.snippet;
            }
            return compact;
        });

        return {
            results: compactResults,
            pagination: {
                total: rawPagination.total,
                offset,
                limit,
                returned: paginated.length,
                has_more: offset + limit < rawPagination.total
            },
            meta: {
                trace_id: traceId,
                count: paginated.length,
                storage: 'filesystem',
                reranked: true,
                query_expanded: true,
                vector_used: vectorUsed,
                vector_results: vectorResults.length
            }
        };

    } catch (err) {
        logger.error('memory_search error', { error: err.message, trace_id: traceId });
        throw err;
    }
}

export default { definition, execute };
