/**
 * Keyword-based search
 * @module retrieval/keyword
 */
import { query, getDbType } from '../db/index.js';
import { extractKeywords, normalizeText } from '../utils/normalize.js';
import logger from '../utils/logger.js';

/**
 * Search using keywords/FTS
 * @param {object} params
 * @param {string} params.query - Search query
 * @param {string} params.projectId
 * @param {string} params.tenantId
 * @param {string[]} params.types - Filter by types
 * @param {string[]} params.tags - Filter by tags
 * @param {string[]} params.excludeStatus - Statuses to exclude
 * @param {number} params.limit
 * @returns {Promise<Array<{id: string, score: number, title: string, content: string}>>}
 */
export async function keywordSearch(params) {
    const {
        query: searchQuery,
        projectId = 'default',
        tenantId = 'local-user',
        types = [],
        tags = [],
        excludeStatus = ['deleted'],
        limit = 50
    } = params;

    const dbType = getDbType();
    const keywords = extractKeywords(searchQuery);

    if (keywords.length === 0) {
        // No keywords, return recent items
        return recentItems({ projectId, tenantId, types, tags, excludeStatus, limit });
    }

    if (dbType === 'postgres') {
        return postgresSearch({ keywords, projectId, tenantId, types, tags, excludeStatus, limit });
    } else {
        return sqliteSearch({ keywords, projectId, tenantId, types, tags, excludeStatus, limit, searchQuery });
    }
}

/**
 * PostgreSQL full-text search
 */
async function postgresSearch({ keywords, projectId, tenantId, types, tags, excludeStatus, limit }) {
    // v5.3: AND for ≥3 keywords (precision), OR for 1-2 (recall)
    const tsQuery = keywords.length >= 3
        ? keywords.slice(0, 5).map(k => `${k}:*`).join(' & ')
        : keywords.map(k => `${k}:*`).join(' | ');

    let sql = `
    SELECT 
      id, title, content, type, tags, status, verified, confidence, version,
      ts_rank(to_tsvector('english', title || ' ' || content), to_tsquery($1)) as score
    FROM memory_items
    WHERE tenant_id = $2 AND project_id = $3
      AND status NOT IN (${excludeStatus.map((_, i) => `$${i + 4}`).join(',')})
  `;

    const params = [tsQuery, tenantId, projectId, ...excludeStatus];
    let paramIdx = params.length;

    if (types.length > 0) {
        sql += ` AND type IN (${types.map((_, i) => `$${paramIdx + i + 1}`).join(',')})`;
        params.push(...types);
        paramIdx += types.length;
    }

    if (tags.length > 0) {
        sql += ` AND tags ?| $${paramIdx + 1}`;
        params.push(tags);
    }

    sql += ` ORDER BY score DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const rows = await query(sql, params);
    return rows.map(row => ({
        id: row.id,
        score: parseFloat(row.score) || 0,
        title: row.title,
        content: row.content,
        type: row.type,
        tags: row.tags,
        status: row.status,
        verified: row.verified,
        confidence: row.confidence,
        version: row.version
    }));
}

/**
 * SQLite FTS5 search
 */
async function sqliteSearch({ keywords, projectId, tenantId, types, tags, excludeStatus, limit, searchQuery }) {
    // v5.3: Smart FTS query — AND for ≥3 keywords (precision), OR for 1-2 (recall)
    // AND with fallback: if AND returns <3 results, retry with OR to preserve recall
    const useAnd = keywords.length >= 3;
    const andKeywords = useAnd ? keywords.slice(0, 5) : keywords; // Cap AND at 5 to avoid over-restriction
    const ftsQueryAnd = andKeywords.map(k => `"${k}"*`).join(' AND ');
    const ftsQueryOr = keywords.map(k => `"${k}"*`).join(' OR ');
    const ftsQuery = useAnd ? ftsQueryAnd : ftsQueryOr;

    const buildSql = (matchQuery) => {
        let sql = `
        SELECT
          m.id, m.title, m.content, m.type, m.tags, m.status, m.verified, m.confidence, m.version, m.created_at, m.updated_at,
          bm25(memory_items_fts) as score
        FROM memory_items_fts fts
        JOIN memory_items m ON fts.id = m.id
        WHERE memory_items_fts MATCH ?
          AND m.tenant_id = ? AND m.project_id = ?
      `;

        const p = [matchQuery, tenantId, projectId];

        const statusPlaceholders = excludeStatus.map(() => '?').join(',');
        sql += ` AND m.status NOT IN (${statusPlaceholders})`;
        p.push(...excludeStatus);

        if (types.length > 0) {
            const typePlaceholders = types.map(() => '?').join(',');
            sql += ` AND m.type IN (${typePlaceholders})`;
            p.push(...types);
        }

        if (tags.length > 0) {
            const tagConditions = tags.map(() => `m.tags LIKE ?`).join(' OR ');
            sql += ` AND (${tagConditions})`;
            p.push(...tags.map(t => `%"${t}"%`));
        }

        sql += ` ORDER BY score LIMIT ?`;
        p.push(limit);

        return { sql, params: p };
    };

    const mapRow = (row) => ({
        id: row.id,
        score: Math.abs(parseFloat(row.score) || 0),
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
    });

    try {
        // Primary query (AND for ≥3 keywords, OR for 1-2)
        const primary = buildSql(ftsQuery);
        const rows = await query(primary.sql, primary.params);
        const results = rows.map(mapRow);

        // v5.3: AND fallback — if AND returned <3 results, retry with OR for better recall
        if (useAnd && results.length < 3) {
            logger.info('FTS AND returned few results, falling back to OR', {
                andResults: results.length,
                keywords: keywords.length
            });
            const fallback = buildSql(ftsQueryOr);
            const orRows = await query(fallback.sql, fallback.params);
            return orRows.map(mapRow);
        }

        return results;
    } catch (err) {
        // Fallback to LIKE search if FTS fails entirely
        logger.warn('FTS search failed, falling back to LIKE', { error: err.message });
        return likeSearch({ keywords, projectId, tenantId, types, tags, excludeStatus, limit });
    }
}

/**
 * Fallback LIKE search
 */
async function likeSearch({ keywords, projectId, tenantId, types, tags, excludeStatus, limit }) {
    const conditions = keywords.map(() => `(title LIKE ? OR content LIKE ?)`);
    const params = [];

    for (const keyword of keywords) {
        params.push(`%${keyword}%`, `%${keyword}%`);
    }

    let sql = `
    SELECT id, title, content, type, tags, status, verified, confidence, version
    FROM memory_items
    WHERE tenant_id = ? AND project_id = ?
      AND (${conditions.join(' OR ')})
  `;

    params.unshift(tenantId, projectId);

    const statusPlaceholders = excludeStatus.map(() => '?').join(',');
    sql += ` AND status NOT IN (${statusPlaceholders})`;
    params.push(...excludeStatus);

    if (types.length > 0) {
        const typePlaceholders = types.map(() => '?').join(',');
        sql += ` AND type IN (${typePlaceholders})`;
        params.push(...types);
    }

    sql += ` ORDER BY updated_at DESC LIMIT ?`;
    params.push(limit);

    const rows = await query(sql, params);

    // Calculate simple keyword match score
    return rows.map(row => {
        const text = normalizeText((row.title || '') + ' ' + (row.content || ''));
        let matchCount = 0;
        for (const keyword of keywords) {
            if (text.includes(keyword)) matchCount++;
        }
        return {
            ...row,
            score: matchCount / keywords.length
        };
    });
}

/**
 * Get recent items when no keywords
 */
async function recentItems({ projectId, tenantId, types, tags, excludeStatus, limit }) {
    let sql = `
    SELECT id, title, content, type, tags, status, verified, confidence, version
    FROM memory_items
    WHERE tenant_id = ? AND project_id = ?
  `;

    const params = [tenantId, projectId];

    const statusPlaceholders = excludeStatus.map(() => '?').join(',');
    sql += ` AND status NOT IN (${statusPlaceholders})`;
    params.push(...excludeStatus);

    if (types.length > 0) {
        const typePlaceholders = types.map(() => '?').join(',');
        sql += ` AND type IN (${typePlaceholders})`;
        params.push(...types);
    }

    sql += ` ORDER BY updated_at DESC LIMIT ?`;
    params.push(limit);

    const rows = await query(sql, params);
    return rows.map(row => ({ ...row, score: 0.5 })); // Default score for recency-based
}

export default { keywordSearch };
