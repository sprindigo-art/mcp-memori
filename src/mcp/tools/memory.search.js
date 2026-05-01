/**
 * memory.search v7.0 — File-based Runbook Search with Intelligence Layer
 * Query expansion + reranking + target-tag boost + credential priority
 * @module mcp/tools/memory.search
 */
import { searchRunbooks, readRunbook, RUNBOOKS_DIR } from '../../storage/files.js';
import filesModule from '../../storage/files.js';
const { expandQueryWords } = filesModule;
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
    'access', 'akses', 'login', 'connect', 'pivot', 'escalate', 'privesc', 'dump',
    'failed', 'success', 'blocked', 'patched', 'active', 'gagal', 'berhasil',
    'full', 'updated', 'server', 'target', 'host', 'domain', 'windows', 'linux',
    'tier', 'phase', 'chain', 'teknik', 'technique', 'runbook', 'universal',
    'root', 'admin', 'sudo', 'cve', 'poc', 'exploit'
]);

const SNIPPET_UNIQUE_COMMON = new Set([
    'ssh', 'credential', 'akses', 'login', 'access', 'password',
    'root', 'admin', 'exploit', 'server', 'target', 'host', 'domain'
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

    // v8.2: For domain keywords, generate ALL part variants
    // "pushidrosal.tnial" → pushidrosal, tnial
    // "sdccd.edu" → sdccd
    // "cms.penangpearl.my" → cms, penangpearl
    const targetVariants = new Set(targetKeywords);
    for (const tk of targetKeywords) {
        if (tk.includes('.')) {
            for (const part of tk.split('.')) {
                if (part.length >= 3 && !COMMON_TECHNIQUE_WORDS.has(part)
                    && !/^\d+$/.test(part)
                    && !/^(com|net|org|edu|gov|mil|int|info|biz|name|pro)$/i.test(part)
                    && !/^(id|my|sg|th|uk|au|us|jp|kr|cn|tw|ph|vn|in|br)$/i.test(part)
                    && !/^(go|ac|or|co|web|sch)$/i.test(part)) {
                    targetVariants.add(part);
                }
            }
        }
    }

    return results.map(item => {
        let score = item.score || 0;

        // TARGET-TAG BOOST: Items with matching target tags get priority
        if (targetVariants.size > 0) {
            const itemTags = (item.tags || []).map(t => (t || '').toLowerCase());
            const idLower = (item.id || '').toLowerCase();
            // v8.3: Count matches — exact tag match counts double (very strong signal)
            let tagScore = 0;
            for (const tk of targetVariants) {
                const exactTag = itemTags.includes(tk);
                const partialTag = !exactTag && itemTags.some(t => t.includes(tk) || tk.includes(t));
                const idMatch = !exactTag && !partialTag && idLower.includes(tk);
                if (exactTag) tagScore += 2;
                else if (partialTag || idMatch) tagScore += 1;
            }
            if (tagScore > 0) {
                const effectiveMatches = tagScore;
                const matchRatio = effectiveMatches / (targetVariants.size * 2);
                const boost = matchRatio >= 0.5 ? 1.5 : effectiveMatches >= 3 ? 1.2 : Math.min(0.8, effectiveMatches * 0.25);
                score *= (1 + boost);
            }

            // TITLE TARGET BOOST: Title containing target name gets extra priority
            const titleLower = (item.title || '').toLowerCase();
            const titleTargetMatches = [...targetVariants].filter(tk => titleLower.includes(tk)).length;
            if (titleTargetMatches > 0) {
                score *= (1 + titleTargetMatches * 0.25);
            }
        }

        // v8.2: TITLE KEYWORD DENSITY BOOST — only count NON-COMMON words in title
        // Prevents generic technique runbooks from outranking specific target runbooks
        const titleLower = (item.title || '').toLowerCase();
        const titleWordMatches = queryWords.filter(w => !COMMON_TECHNIQUE_WORDS.has(w) && titleLower.includes(w)).length;
        if (titleWordMatches >= 2) {
            score *= (1 + titleWordMatches * 0.4);
        }

        // ERROR PENALTY: Items with known failures score lower
        const snippetLower = (item.snippet || '').toLowerCase();
        if (snippetLower.includes('gagal') || snippetLower.includes('failed') || snippetLower.includes('blocked')) {
            if (!queryWords.some(w => ['gagal', 'failed', 'error', 'blocked'].includes(w))) {
                score *= 0.85;
            }
        }

        // v8.3 Fix 13: TEKNIK docs depriority for target-access queries
        if (titleLower.startsWith('[teknik]') && targetVariants.size > 0) {
            const titleHasTarget = [...targetVariants].some(tk => titleLower.includes(tk));
            if (!titleHasTarget) {
                score *= 0.4;
            }
        }

        // v8.3 Fix 15: Snippet content target match boost (with auto-log guard)
        if (targetVariants.size > 0) {
            const isAutoLogSnip = snippetLower.includes('tool_use/') || snippetLower.includes('| json(') || snippetLower.includes('_auto_log]');
            if (!isAutoLogSnip) {
                const snipTargetHits = [...targetVariants].filter(tk => snippetLower.includes(tk)).length;
                if (snipTargetHits > 0) {
                    score *= (1 + snipTargetHits * 0.3);
                }
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
            // v2.0: Carry matched_section from vector results
            const vecSectionMap = new Map();
            for (const vr of vectorResults) {
                if (vr.matched_section) vecSectionMap.set(vr.id, vr.matched_section);
            }
            for (const item of mergedResults) {
                if (vecSectionMap.has(item.id)) item.matched_section = vecSectionMap.get(item.id);
            }
        } else {
            mergedResults = rawResults;
        }

        // v8.2: Enrich ALL items missing title/snippet/content_length
        const originalWords = (searchQuery || '').toLowerCase().split(/\s+/).filter(w => w.length >= 2);
        const origSet = new Set(originalWords);
        // Build snippet scoring words: original + domain part variants
        const snippetWords = [...originalWords];
        for (const w of originalWords) {
            if (w.includes('.')) {
                for (const part of w.split('.')) {
                    if (part.length >= 3 && !origSet.has(part)) snippetWords.push(part);
                }
            }
        }
        const queryWords = expandQueryWords(searchQuery);
        for (const item of mergedResults) {
            // v8.2: DOMAIN_MATCH snippets — keep only if they also match other query words
            if (item.snippet && item.snippet.startsWith('\x00DOMAIN_MATCH\x00')) {
                item.snippet = item.snippet.replace('\x00DOMAIN_MATCH\x00', '');
                const dmLower = item.snippet.toLowerCase();
                const dmHits = snippetWords.filter(w => dmLower.includes(w)).length;
                if (dmHits >= Math.ceil(snippetWords.length * 0.5)) continue;
                item.snippet = null;
            }
            const snippetLower = (item.snippet || '').toLowerCase();
            const snippetOrigHits = originalWords.filter(w => snippetLower.includes(w)).length;
            let needsSnippetFix = item.snippet && origSet.size >= 2 && snippetOrigHits < Math.ceil(origSet.size * 0.6);
            if (!needsSnippetFix && item.snippet) {
                const uniqueQWords = originalWords.filter(w => w.length >= 3 && !SNIPPET_UNIQUE_COMMON.has(w));
                if (uniqueQWords.length > 0 && !uniqueQWords.some(w => snippetLower.includes(w))) {
                    needsSnippetFix = true;
                }
            }
            if (item.title && item.snippet && item.content_length && !needsSnippetFix) continue;
            if (needsSnippetFix) item.snippet = null;
            try {
                const rb = readRunbook(item.id);
                if (!rb) continue;
                if (!item.title) item.title = rb.title || item.id;
                if (!item.content_length) item.content_length = rb.content_length || 0;
                if (!item.tags) item.tags = rb.tags || [];
                if (!item.version) item.version = rb.version || 1;
                if (!item.created_at) item.created_at = rb.created_at;
                if (!item.updated_at) item.updated_at = rb.updated_at;
                if (!item.snippet) {
                    const body = rb.content || '';
                    const sections = body.split(/(?=^## )/m);
                    let bestSnip = '';
                    let bestScore = 0;
                    const uniqueWords = snippetWords.filter(w => w.length >= 3 && !SNIPPET_UNIQUE_COMMON.has(w));
                    for (const sec of sections) {
                        const secLower = sec.toLowerCase();
                        if (secLower.startsWith('## _auto_log') || secLower.startsWith('## session log') || secLower.startsWith('## _changelog')) continue;
                        const headerLine = (sec.match(/^## ([^\n]+)/)?.[1] || '').toLowerCase();
                        let sc = 0;
                        for (const w of snippetWords) {
                            const wl = w.toLowerCase();
                            if (wl.length >= 3 && headerLine.includes(wl)) sc += 20;
                            const bodyMatches = wl.length >= 3
                                ? secLower.split(wl).length - 1
                                : (secLower.match(new RegExp('\\b' + wl + '\\b', 'g')) || []).length;
                            if (bodyMatches > 0) sc += Math.min(5, bodyMatches) * 3;
                        }
                        const uniqueInHeader = uniqueWords.filter(w => headerLine.includes(w)).length;
                        if (uniqueInHeader > 0) sc *= (1 + uniqueInHeader * 0.4);
                        const uniqueInBody = uniqueWords.filter(w => secLower.includes(w)).length;
                        if (uniqueInBody > 0) {
                            const distinctHits = snippetWords.filter(w => {
                                const wl = w.toLowerCase();
                                return wl.length >= 3 ? secLower.includes(wl) : new RegExp('\\b' + wl + '\\b').test(secLower);
                            }).length;
                            if (distinctHits >= Math.ceil(snippetWords.length * 0.6)) sc *= 2.0;
                        }
                        if (sec.length < 3000 && sc > 0) sc *= 1.5;
                        if (sc > bestScore) { bestScore = sc; bestSnip = sec; }
                    }
                    if (bestSnip) {
                        const headerMatch = bestSnip.match(/^## ([^\n]+)/);
                        const bh = (headerMatch?.[1] || '').toLowerCase();
                        if (bh.startsWith('_auto_log') || bh.startsWith('session log') || bh.startsWith('_changelog')) {
                            bestSnip = '';
                        }
                    }
                    if (bestSnip) {
                        const headerMatch = bestSnip.match(/^## ([^\n]+)/);
                        const sectionName = headerMatch ? `[${headerMatch[1]}] ` : '';
                        let clean = bestSnip.replace(/^## [^\n]+\n/, '').trim();
                        // Skip metadata lines (Type:, Tags:, Confidence:, Created:, Updated:)
                        const metaRe = /^(\*\*Type:\*\*|\*\*Tags:\*\*|\*\*Confidence:\*\*|\*\*Created:\*\*|\*\*Updated:\*\*|<!-- ).+$/gm;
                        clean = clean.replace(metaRe, '').replace(/\n{2,}/g, '\n').trim();
                        const cleanLower = clean.toLowerCase();
                        let bestStart = 0;
                        let bestDensity = 0;
                        for (let pos = 0; pos < cleanLower.length - 50; pos += 30) {
                            const window = cleanLower.substring(pos, pos + 400);
                            let density = 0;
                            for (const w of snippetWords) {
                                if (window.includes(w)) density++;
                            }
                            if (density > bestDensity) {
                                bestDensity = density;
                                bestStart = Math.max(0, pos - 20);
                            }
                        }
                        let finalClean = clean.substring(bestStart, bestStart + 500);
                        // If snippet too short, grab content from next sections
                        if (finalClean.length < 100) {
                            const secIdx = sections.indexOf(bestSnip);
                            if (secIdx >= 0) {
                                let extra = '';
                                for (let j = secIdx + 1; j < Math.min(secIdx + 4, sections.length); j++) {
                                    extra += '\n' + sections[j].replace(/^## [^\n]+\n/, '').replace(metaRe, '').trim();
                                    if (extra.length > 400) break;
                                }
                                finalClean = finalClean + extra.substring(0, 500 - finalClean.length);
                            }
                        }
                        item.snippet = sectionName + finalClean;
                    } else {
                        item.snippet = body.substring(0, 500);
                    }
                }
            } catch {}
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

        // v8.0: Readable list output — longer snippets, section-aware
        const outLines = [];
        outLines.push(`# Search: "${searchQuery}" — ${paginated.length} of ${rawPagination.total} results\n`);
        for (let i = 0; i < compactResults.length; i++) {
            const item = compactResults[i];
            const title = item.title || item.id || '';
            const sizeKb = item.content_length ? Math.round(item.content_length / 1024) + 'KB' : '-';
            const snipRaw = (item.snippet || '').replace(/[\n\r]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
            const snip = snipRaw.length > 300 ? snipRaw.substring(0, 297) + '...' : snipRaw;
            outLines.push(`**${i + 1}. ${title}** (v${item.version || 1}, ${sizeKb}) — score: ${item.score}`);
            outLines.push(`   ID: \`${item.id}\``);
            if (snip) outLines.push(`   > ${snip}`);
            outLines.push('');
        }
        if (rawPagination.total > offset + limit) {
            outLines.push(`> **Next page:** memory_search({query:"${searchQuery}", offset:${offset + limit}, project_id:"..."})`);
        }
        outLines.push(`> **Baca:** memory_get({id:"ID"}) — **Per section:** memory_get({id:"...", section:"NAMA_SECTION"})`);

        return {
            __plaintext: true,
            text: outLines.join('\n'),
            _raw: {
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
            }
        };

    } catch (err) {
        logger.error('memory_search error', { error: err.message, trace_id: traceId });
        throw err;
    }
}

export default { definition, execute };
