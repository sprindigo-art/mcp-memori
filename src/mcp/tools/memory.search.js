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
            limit: { type: 'number', description: 'Max results (default: 10)' },
            override_quarantine: { type: 'boolean', description: 'Include quarantined items (default: false)' },
            allow_relations: { type: 'boolean', description: 'Enable multi-hop graph reasoning (default: false)' }
        },
        required: ['query', 'project_id']
    }
};

import { getForensicMeta } from '../../utils/forensic.js';

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
        limit = 10,
        override_quarantine: overrideQuarantine = false,
        allow_relations: allowRelations = false
    } = params;

    try {
        // PERFORMA FILTERING (NORMAL SEARCH)
        const { results: rawResults, meta: searchMeta } = await hybridSearch({
            query: searchQuery,
            projectId,
            tenantId,
            types,
            tags: normalizeTags(tags),
            overrideQuarantine,
            limit: limit * 2 // Get more for reranking
        });

        // FORENSIC SEARCH: Cari yang disembunyikan
        let excludedItems = [];
        if (!overrideQuarantine) {
            // Kita lakukan search terpisah KHUSUS untuk barang quarantined
            // agar bisa diekspos sebagai "Excluded" di metadata forensik
            const { results: hiddenResults } = await hybridSearch({
                query: searchQuery,
                projectId,
                tenantId,
                types,
                tags: normalizeTags(tags),
                overrideQuarantine: true, // Force include
                limit: 5 // Cukup ambil sampel
            });

            // Filter hanya yang statusnya quarantined dan tidak ada di hasil normal
            const normalIds = new Set(rawResults.map(r => r.id));
            excludedItems = hiddenResults
                .filter(r => r.status === 'quarantined' && !normalIds.has(r.id))
                .map(r => ({
                    id: r.id,
                    title: r.title,
                    reason: 'quarantined',
                    original_status: r.status
                }));
        }

        // Rerank results
        const reranked = rerank(rawResults, searchQuery, { maxResults: limit });

        // Format results - LAYER 1,3 Enhanced
        const results = reranked.map(item => ({
            id: item.id,
            type: item.type,
            title: item.title,
            snippet: generateSnippet(item.content, 150),

            // SCORE BREAKDOWN - Enhanced with LAYER 3 temporal_type
            final_score: Math.round((item.final_score || item.score) * 1000) / 1000,
            score_breakdown: {
                keyword: Math.round((item.keyword_score || item.score_breakdown?.keyword || 0) * 1000) / 1000,
                vector: Math.round((item.vector_score || item.score_breakdown?.vector || 0) * 1000) / 1000,
                recency: Math.round((item.recency_score || item.score_breakdown?.recency || 0) * 1000) / 1000,
                verified_bonus: item.verified_bonus || item.score_breakdown?.verified_bonus || 0,
                temporal_type: item.score_breakdown?.temporal_type || 'state'
            },

            status: item.status,
            verified: !!item.verified,
            confidence: item.confidence,
            version: item.version,
            provenance_summary: summarizeProvenance(item.provenance_json)
        }));

        // Update last_used_at
        if (results.length > 0) {
            const ids = results.map(r => r.id);
            const placeholders = ids.map(() => '?').join(',');
            await query(
                `UPDATE memory_items SET last_used_at = ? WHERE id IN (${placeholders})`,
                [now(), ...ids]
            );
        }

        // Build Forensic Metadata
        const forensicMeta = await getForensicMeta(tenantId, projectId);

        // Write audit log
        await writeAuditLog(traceId, 'memory_search', params, {
            result_count: results.length,
            top_ids: results.slice(0, 3).map(r => r.id),
            search_mode: searchMeta.mode,
            excluded_count: excludedItems.length
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

        return {
            results,
            related: allowRelations ? relatedResults : undefined,
            excluded: excludedItems,
            meta: {
                trace_id: traceId,
                mode: searchMeta.mode,
                requested_mode: searchMeta.requestedMode,
                weights_used: searchMeta.weights,
                fallback_reason: searchMeta.fallbackReason,
                duration_ms: Date.now() - startTime,
                relations_enabled: allowRelations,
                relations_used: relationsUsed,
                forensic: forensicMeta
            }
        };

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
