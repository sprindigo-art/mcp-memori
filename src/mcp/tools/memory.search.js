/**
 * memory.search v3.0 - Hybrid search with multi-hop reasoning
 * @module mcp/tools/memory.search
 */
import { hybridSearch } from '../../retrieval/hybridSearch.js';
import { rerank, diversify } from '../../retrieval/rerank.js';
import { getEmbeddingMode, getEmbeddingBackend } from '../../utils/embedding.js';
import { getDbType, query } from '../../db/index.js';
import { generateSnippet, normalizeTags } from '../../utils/normalize.js';
import { v4 as uuidv4 } from 'uuid';
import { now } from '../../utils/time.js';
import logger from '../../utils/logger.js';
import { traverseGraph, getRelations } from '../../retrieval/graph.js';

/**
 * Tool definition for MCP
 */
export const definition = {
    name: 'memory_search',
    description: 'Cari memori berdasarkan query dengan hybrid search (vector + keyword + recency)',
    inputSchema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Search query' },
            project_id: { type: 'string', description: 'Project ID' },
            types: {
                type: 'array',
                items: { type: 'string' },
                description: 'Filter by types: fact, state, decision, runbook, episode'
            },
            tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Filter by tags'
            },
            required_tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Mandatory tags - results MUST contain ALL of these tags'
            },
            limit: { type: 'number', description: 'Max results (default: 10)' },
            override_quarantine: { type: 'boolean', description: 'Include quarantined items (default: false)' },
            allow_relations: { type: 'boolean', description: 'Enable multi-hop graph reasoning (default: false)' }
        },
        required: ['query', 'project_id']
    }
};

import { getForensicMeta } from '../../utils/forensic.js';

/**
 * QUERY EXPANSION v1.0
 * Expand search query with synonyms for better recall
 * Focus on security/hacking domain terms
 */
const QUERY_SYNONYMS = {
    // Tunneling & Pivoting
    'chisel': ['tunnel', 'proxy', 'pivot', 'forward', 'socks'],
    'tunnel': ['chisel', 'proxy', 'ssh tunnel', 'port forward', 'pivot'],
    'pivot': ['tunnel', 'lateral', 'proxy', 'chisel'],

    // Shells & Access
    'webshell': ['backdoor', 'shell', 'rce', 'persistence', 'upload'],
    'backdoor': ['webshell', 'persistence', 'trojan', 'implant'],
    'shell': ['webshell', 'reverse shell', 'bind shell', 'terminal'],
    'rce': ['remote code execution', 'command injection', 'webshell'],

    // Credentials
    'credential': ['password', 'username', 'login', 'auth', 'creds'],
    'password': ['credential', 'pass', 'pwd', 'secret'],
    'username': ['user', 'login', 'credential'],

    // Vulnerabilities
    'sqli': ['sql injection', 'database', 'injection'],
    'xss': ['cross site scripting', 'script injection'],
    'lfi': ['local file inclusion', 'file read', 'path traversal'],
    'ssrf': ['server side request forgery', 'internal', 'fetch'],

    // Recon
    'recon': ['reconnaissance', 'scan', 'enumeration', 'discovery'],
    'scan': ['nmap', 'port', 'recon', 'enumeration'],

    // General
    'exploit': ['vulnerability', 'payload', 'attack', 'hack'],
    'vuln': ['vulnerability', 'exploit', 'weakness', 'flaw']
};

/**
 * Expand query with synonyms
 * @param {string} query - Original search query
 * @returns {string} Expanded query
 */
function expandQuery(query) {
    if (!query) return query;

    const queryLower = query.toLowerCase();
    const originalTerms = queryLower.split(/\s+/);
    const expandedTerms = new Set(originalTerms);

    let expansionsAdded = 0;
    const MAX_EXPANSIONS = 5; // Cap total expanded terms to prevent over-broadening

    // Check each synonym group
    for (const [key, synonyms] of Object.entries(QUERY_SYNONYMS)) {
        if (expansionsAdded >= MAX_EXPANSIONS) break;
        if (queryLower.includes(key)) {
            // Add up to 2 most relevant synonyms (reduced from 3)
            synonyms.slice(0, 2).forEach(syn => {
                if (expansionsAdded >= MAX_EXPANSIONS) return;
                // Only add single-word synonyms to avoid phrase explosion
                if (!syn.includes(' ')) {
                    expandedTerms.add(syn);
                    expansionsAdded++;
                }
            });
        }
    }

    // Return expanded query (original + synonyms)
    return Array.from(expandedTerms).join(' ');
}

/**
 * Execute memory search
 * @param {object} params
 * @returns {Promise<object>}
 */
export async function execute(params) {
    const traceId = uuidv4();
    const startTime = Date.now();

    const {
        query: searchQuery,
        project_id: projectId,
        tenant_id: tenantId = 'local-user',
        types = [],
        tags = [],
        required_tags: requiredTags = [],
        limit = 50,
        override_quarantine: overrideQuarantine = false,
        allow_relations: allowRelations = false
    } = params;

    // QUERY EXPANSION: Expand query with synonyms for better recall
    const expandedQuery = expandQuery(searchQuery);
    const queryWasExpanded = expandedQuery !== searchQuery.toLowerCase();

    try {
        // PERFORMA FILTERING (NORMAL SEARCH) - Using expanded query for better recall
        const { results: rawResults, meta: searchMeta } = await hybridSearch({
            query: expandedQuery,
            projectId,
            tenantId,
            types,
            tags: normalizeTags(tags),
            overrideQuarantine,
            limit: limit * 2 // Get more for reranking
        });

        // Rerank results
        let reranked = rerank(rawResults, searchQuery, { maxResults: limit * 2 });

        // REQUIRED_TAGS FILTER: Post-filter to ensure ALL required tags are present
        if (requiredTags.length > 0) {
            reranked = reranked.filter(item => {
                let itemTags = [];
                try { itemTags = typeof item.tags === 'string' ? JSON.parse(item.tags || '[]') : (item.tags || []); } catch { itemTags = []; }
                const lowerTags = itemTags.map(t => t.toLowerCase());
                return requiredTags.every(rt => lowerTags.includes(rt.toLowerCase()));
            });
        }

        // Take top N after filtering
        reranked = reranked.slice(0, limit);

        // Format results - WITH SNIPPET + TAGS for immediate understanding
        const results = reranked.map(item => ({
            id: item.id,
            type: item.type,
            title: item.title,
            snippet: generateSnippet(item.content || '', 150),
            tags: (() => { try { return typeof item.tags === 'string' ? JSON.parse(item.tags || '[]') : (item.tags || []); } catch { return []; } })(),
            score: Math.round((item.final_score || item.score) * 1000) / 1000
        }));

        // Update last_used_at ONLY (score increment moved to memory_get for true interest signal)
        if (results.length > 0) {
            const ids = results.map(r => r.id);
            const placeholders = ids.map(() => '?').join(',');
            await query(
                `UPDATE memory_items SET last_used_at = ? WHERE id IN (${placeholders})`,
                [now(), ...ids]
            );
        }

        // GUARDRAIL WARNING CHECK: Surface relevant warnings from guardrails table
        let warnings = [];
        try {
            // Extract CVE patterns and key terms from the original query
            const cveInQuery = (searchQuery || '').match(/CVE-\d{4}-\d{4,}/gi) || [];
            const queryTerms = (searchQuery || '').toLowerCase().split(/\s+/).filter(t => t.length > 3);

            // Check guardrails table for matching patterns
            const activeGuardrails = await query(
                `SELECT description, pattern_signature, rule_type FROM guardrails 
                 WHERE tenant_id = ? AND project_id = ? AND active = 1
                 AND (expires_at IS NULL OR expires_at > ?)`,
                [tenantId, projectId, now()]
            );

            for (const g of activeGuardrails) {
                const descLower = (g.description || '').toLowerCase();
                // Match if: CVE in query matches guardrail, or query keyword appears in description
                const cveMatch = cveInQuery.some(cve => descLower.includes(cve.toLowerCase()));
                const keywordMatch = queryTerms.some(term =>
                    descLower.includes(term) &&
                    !['dari', 'yang', 'untuk', 'pada', 'dengan', 'running', 'caused'].includes(term)
                );

                if (cveMatch || keywordMatch) {
                    warnings.push({
                        rule_type: g.rule_type,
                        message: g.description
                    });
                }
            }
        } catch (err) {
            logger.warn('Guardrail warning check failed', { error: err.message });
        }

        // Build Compact Forensic Metadata (no UUID bloat)
        const forensicMeta = await getForensicMeta(tenantId, projectId);

        // Write audit log
        await writeAuditLog(traceId, 'memory_search', params, {
            result_count: results.length,
            top_ids: results.slice(0, 3).map(r => r.id),
            search_mode: searchMeta.mode
        }, projectId, tenantId);

        // MULTI-HOP REASONING (v3.0)
        let relationsUsed = [];
        let relatedResults = [];

        if (allowRelations && results.length > 0) {
            try {
                // Traverse from top results to find related items
                for (const item of results.slice(0, 3)) {
                    const related = await traverseGraph(item.id, 2, ['causes', 'depends_on', 'related_to']);

                    for (const rel of related) {
                        // Get item details
                        const rows = await query(
                            'SELECT id, title, type, content, status FROM memory_items WHERE id = ? AND status = ?',
                            [rel.id, 'active']
                        );

                        if (rows.length > 0) {
                            const relItem = rows[0];
                            relatedResults.push({
                                id: relItem.id,
                                title: relItem.title,
                                type: relItem.type,
                                snippet: generateSnippet(relItem.content, 100),
                                hop: rel.hop,
                                relation: rel.relation,
                                path: rel.path,
                                source_id: item.id,
                                source_title: item.title
                            });

                            relationsUsed.push({
                                from: item.id,
                                to: rel.id,
                                type: rel.relation,
                                hop: rel.hop
                            });
                        }
                    }
                }
            } catch (err) {
                logger.warn('Multi-hop traversal failed', { error: err.message });
            }
        }

        const response = {
            results,
            meta: {
                trace_id: traceId,
                count: results.length
            }
        };

        // Inject warnings ONLY if found — does not pollute clean results
        if (warnings.length > 0) {
            response.warnings = warnings;
        }

        return response;

    } catch (err) {
        logger.error('memory_search error', { error: err.message, trace_id: traceId });
        throw err;
    }
}

/**
 * Summarize provenance JSON
 * @param {string|object} provenance 
 * @returns {string}
 */
function summarizeProvenance(provenance) {
    if (!provenance) return '';

    try {
        const p = typeof provenance === 'string' ? JSON.parse(provenance) : provenance;
        if (p.source) return `Source: ${p.source}`;
        if (p.created_by) return `By: ${p.created_by}`;
        return '';
    } catch {
        return '';
    }
}

/**
 * Write to audit log
 */
async function writeAuditLog(traceId, toolName, request, response, projectId, tenantId) {
    try {
        await query(
            `INSERT INTO audit_log (id, trace_id, ts, tool_name, request_json, response_json, project_id, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                uuidv4(),
                traceId,
                now(),
                toolName,
                JSON.stringify(request),
                JSON.stringify(response),
                projectId,
                tenantId
            ]
        );
    } catch (err) {
        logger.warn('Audit log write failed', { error: err.message });
    }
}

export default { definition, execute };
