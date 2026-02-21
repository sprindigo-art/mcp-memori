/**
 * memory.list - Browse and filter memory items without search query
 * v5.2 - New tool for paginated browsing
 * @module mcp/tools/memory.list
 */
import { query, queryOne } from '../../db/index.js';
import { v4 as uuidv4 } from 'uuid';
import { now } from '../../utils/time.js';
import logger from '../../utils/logger.js';
import { getMinimalForensicMeta } from '../../utils/forensic.js';

/**
 * Tool definition for MCP
 */
export const definition = {
    name: 'memory_list',
    description: 'Browse/filter memory items tanpa search query. Supports pagination, tag/type filtering.',
    inputSchema: {
        type: 'object',
        properties: {
            project_id: { type: 'string', description: 'Project ID' },
            types: {
                type: 'array',
                items: { type: 'string' },
                description: 'Filter by types: fact, state, decision, runbook, episode'
            },
            tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Filter by tags (items must contain ALL specified tags)'
            },
            status: {
                type: 'string',
                enum: ['active', 'quarantined', 'deprecated', 'deleted'],
                description: 'Filter by status (default: active)'
            },
            sort_by: {
                type: 'string',
                enum: ['updated_at', 'created_at', 'usefulness_score', 'title'],
                description: 'Sort field (default: updated_at)'
            },
            sort_order: {
                type: 'string',
                enum: ['asc', 'desc'],
                description: 'Sort order (default: desc)'
            },
            limit: {
                type: 'number',
                description: 'Max results per page (default: 20, max: 100)'
            },
            offset: {
                type: 'number',
                description: 'Offset for pagination (default: 0)'
            },
            title_contains: {
                type: 'string',
                description: 'Filter items where title contains this text (case-insensitive)'
            },
            full_content: {
                type: 'boolean',
                description: 'Return full content instead of snippet (default: false)'
            }
        },
        required: ['project_id']
    }
};

/**
 * Execute memory list
 * @param {object} params
 * @returns {Promise<object>}
 */
export async function execute(params) {
    const traceId = uuidv4();
    const {
        project_id: projectId,
        tenant_id: tenantId = 'local-user',
        types = [],
        tags = [],
        status = 'active',
        sort_by: sortBy = 'updated_at',
        sort_order: sortOrder = 'desc',
        limit: rawLimit = 20,
        offset = 0,
        title_contains: titleContains = '',
        full_content: fullContent = false
    } = params;

    // Cap limit at 100
    const limit = Math.min(Math.max(rawLimit, 1), 100);

    // Whitelist sort columns to prevent SQL injection
    const ALLOWED_SORT = ['updated_at', 'created_at', 'usefulness_score', 'title'];
    const safeSortBy = ALLOWED_SORT.includes(sortBy) ? sortBy : 'updated_at';
    const safeSortOrder = sortOrder === 'asc' ? 'ASC' : 'DESC';

    try {
        // Build query
        let sql = `SELECT id, title, type, tags, status, verified, confidence, 
                          usefulness_score, version, created_at, updated_at`;

        if (fullContent) {
            sql += `, content`;
        } else {
            sql += `, SUBSTR(content, 1, 200) as snippet`;
        }

        sql += ` FROM memory_items WHERE tenant_id = ? AND project_id = ? AND status = ?`;
        const sqlParams = [tenantId, projectId, status];

        // Type filter
        if (types.length > 0) {
            const typePlaceholders = types.map(() => '?').join(',');
            sql += ` AND type IN (${typePlaceholders})`;
            sqlParams.push(...types);
        }

        // Tag filter (AND logic: must contain ALL tags)
        if (tags.length > 0) {
            for (const tag of tags) {
                sql += ` AND tags LIKE ?`;
                sqlParams.push(`%"${tag}"%`);
            }
        }

        // Title contains filter
        if (titleContains) {
            sql += ` AND title LIKE ?`;
            sqlParams.push(`%${titleContains}%`);
        }

        // Get total count before pagination (build separate count query)
        let countSql = `SELECT COUNT(*) as total FROM memory_items WHERE tenant_id = ? AND project_id = ? AND status = ?`;
        const countParams = [tenantId, projectId, status];

        if (types.length > 0) {
            const typePlaceholders = types.map(() => '?').join(',');
            countSql += ` AND type IN (${typePlaceholders})`;
            countParams.push(...types);
        }
        if (tags.length > 0) {
            for (const tag of tags) {
                countSql += ` AND tags LIKE ?`;
                countParams.push(`%"${tag}"%`);
            }
        }
        if (titleContains) {
            countSql += ` AND title LIKE ?`;
            countParams.push(`%${titleContains}%`);
        }

        const countResult = await queryOne(countSql, countParams);
        const totalCount = countResult?.total || 0;

        // Add sort and pagination
        sql += ` ORDER BY ${safeSortBy} ${safeSortOrder} LIMIT ? OFFSET ?`;
        sqlParams.push(limit, offset);

        const rows = await query(sql, sqlParams);

        // Format results
        const items = rows.map(row => {
            const item = {
                id: row.id,
                title: row.title,
                type: row.type,
                tags: parseJsonSafe(row.tags, []),
                status: row.status,
                verified: !!row.verified,
                confidence: row.confidence,
                usefulness_score: row.usefulness_score,
                version: row.version,
                created_at: row.created_at,
                updated_at: row.updated_at
            };

            if (fullContent) {
                item.content = row.content;
            } else {
                item.snippet = row.snippet;
            }

            return item;
        });

        // Pagination metadata
        const pagination = {
            total: totalCount,
            limit,
            offset,
            has_more: offset + limit < totalCount,
            next_offset: offset + limit < totalCount ? offset + limit : null,
            pages: Math.ceil(totalCount / limit),
            current_page: Math.floor(offset / limit) + 1
        };

        // Write audit log
        try {
            await query(
                `INSERT INTO audit_log (id, trace_id, ts, tool_name, request_json, response_json, project_id, tenant_id, is_error)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    uuidv4(), traceId, now(), 'memory_list',
                    JSON.stringify({ project_id: projectId, types, tags, status, limit, offset }),
                    JSON.stringify({ returned: items.length, total: totalCount }),
                    projectId, tenantId, 0
                ]
            );
        } catch (auditErr) {
            logger.warn('Audit log write failed', { error: auditErr.message });
        }

        const forensicMeta = getMinimalForensicMeta(tenantId, projectId);

        return {
            items,
            pagination,
            meta: {
                trace_id: traceId,
                forensic: forensicMeta
            }
        };

    } catch (err) {
        logger.error('memory.list error', { error: err.message, trace_id: traceId });
        throw err;
    }
}

/**
 * Parse JSON safely
 */
function parseJsonSafe(value, defaultValue) {
    if (!value) return defaultValue;
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch {
        return defaultValue;
    }
}

export default { definition, execute };
