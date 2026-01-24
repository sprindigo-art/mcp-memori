/**
 * Vector-based search v2.1 - Local embedding via Ollama with fallback
 * @module retrieval/vector
 */
import { query, getDbType } from '../db/index.js';
import { generateEmbedding, cosineSimilarity, shouldUseVector, getLastFallbackReason } from '../utils/embedding.js';
import logger from '../utils/logger.js';

/**
 * Search using vector similarity with fallback support
 * @param {object} params
 * @param {string} params.query - Search query
 * @param {string} params.projectId
 * @param {string} params.tenantId
 * @param {string[]} params.types - Filter by types
 * @param {string[]} params.tags - Filter by tags
 * @param {string[]} params.excludeStatus - Statuses to exclude
 * @param {number} params.limit
 * @returns {Promise<{results: Array, fallbackReason: string|null}|null>}
 */
export async function vectorSearch(params) {
    const {
        query: searchQuery,
        projectId = 'default',
        tenantId = 'local-user',
        types = [],
        tags = [],
        excludeStatus = ['deleted'],
        limit = 50
    } = params;

    // Check if vector mode is enabled
    if (!shouldUseVector()) {
        return { results: [], fallbackReason: 'mode_keyword_only' };
    }

    // Generate query embedding with fallback handling
    const { embedding: queryEmbedding, fallbackReason } = await generateEmbedding(searchQuery);

    if (!queryEmbedding) {
        logger.info('Vector search fallback', { reason: fallbackReason });
        return { results: [], fallbackReason };
    }

    const dbType = getDbType();

    // Get items with embeddings
    let sql = `
    SELECT id, title, content, type, tags, status, verified, confidence, version, embedding,
           created_at, updated_at
    FROM memory_items
    WHERE tenant_id = ? AND project_id = ?
      AND embedding IS NOT NULL
  `;

    const sqlParams = [tenantId, projectId];

    // Add status filter
    const statusPlaceholders = excludeStatus.map(() => '?').join(',');
    sql += ` AND status NOT IN (${statusPlaceholders})`;
    sqlParams.push(...excludeStatus);

    if (types.length > 0) {
        const typePlaceholders = types.map(() => '?').join(',');
        sql += ` AND type IN (${typePlaceholders})`;
        sqlParams.push(...types);
    }

    const rows = await query(sql, sqlParams);

    // Calculate cosine similarity for each row
    const scored = rows.map(row => {
        let embedding;
        try {
            embedding = typeof row.embedding === 'string'
                ? JSON.parse(row.embedding)
                : row.embedding;
        } catch {
            embedding = null;
        }

        const similarity = embedding ? cosineSimilarity(queryEmbedding, embedding) : 0;

        return {
            id: row.id,
            score: similarity, // Already normalized 0-1 by cosineSimilarity
            title: row.title,
            content: row.content,
            type: row.type,
            tags: row.tags,
            status: row.status,
            verified: row.verified,
            confidence: row.confidence,
            version: row.version,
            created_at: row.created_at,
            updated_at: row.updated_at
        };
    });

    // Sort by score and limit
    scored.sort((a, b) => b.score - a.score);

    // Filter by tags if specified (after scoring)
    let filtered = scored;
    if (tags.length > 0) {
        filtered = scored.filter(item => {
            const itemTags = typeof item.tags === 'string'
                ? JSON.parse(item.tags || '[]')
                : (item.tags || []);
            return tags.some(t => itemTags.includes(t));
        });
    }

    return {
        results: filtered.slice(0, limit),
        fallbackReason: null
    };
}

/**
 * Check if vector search is available
 * @returns {boolean}
 */
export function isVectorSearchAvailable() {
    return shouldUseVector();
}

export default { vectorSearch, isVectorSearchAvailable };
