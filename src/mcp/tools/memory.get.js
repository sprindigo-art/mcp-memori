/**
 * memory.get - Get single memory item with LRU caching
 * v4.0 - Server-side cache for reduced DB I/O
 * @module mcp/tools/memory.get
 */
import { queryOne, query } from '../../db/index.js';
import { v4 as uuidv4 } from 'uuid';
import { now } from '../../utils/time.js';
import logger from '../../utils/logger.js';
import { getForensicMeta } from '../../utils/forensic.js';
import { getFromCache, setToCache } from '../../utils/cache.js';

/**
 * Tool definition for MCP
 */
export const definition = {
    name: 'memory_get',
    description: 'Ambil detail lengkap satu memori berdasarkan ID',
    inputSchema: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'Memory item ID' }
        },
        required: ['id']
    }
};

/**
 * Execute memory get
 * @param {object} params
 * @returns {Promise<object>}
 */
export async function execute(params) {
    const traceId = uuidv4();
    const { id } = params;

    try {
        // CHECK CACHE FIRST (v4.0)
        const cachedItem = getFromCache(id);
        let item;
        let cacheHit = false;

        if (cachedItem) {
            item = cachedItem;
            cacheHit = true;
        } else {
            // Cache miss - fetch from DB
            item = await queryOne(
                `SELECT * FROM memory_items WHERE id = ?`,
                [id]
            );

            // Store in cache for future requests
            if (item) {
                setToCache(id, item);
            }
        }

        if (!item) {
            return {
                item: null,
                links: [],
                meta: { trace_id: traceId, error: 'Item not found' }
            };
        }

        // Parse JSON fields
        const formattedItem = formatItem(item);

        // Get links
        const links = await query(
            `SELECT l.*, m.title as target_title, m.type as target_type
       FROM memory_links l
       LEFT JOIN memory_items m ON l.to_id = m.id
       WHERE l.from_id = ?
       UNION
       SELECT l.*, m.title as target_title, m.type as target_type
       FROM memory_links l
       LEFT JOIN memory_items m ON l.from_id = m.id
       WHERE l.to_id = ?`,
            [id, id]
        );

        // Update last_used_at AND auto-increment usefulness_score (true interest signal)
        // +0.01 per get (gradual), cap at 5.0 (max multiplier: 1.36x in ranking)
        await query(
            `UPDATE memory_items SET last_used_at = ?, usefulness_score = MIN(5.0, usefulness_score + 0.01) WHERE id = ?`,
            [now(), id]
        );

        // Invalidate cache since score changed
        const { invalidateCache } = await import('../../utils/cache.js');
        invalidateCache(id);

        // Write audit log
        await writeAuditLog(traceId, 'memory_get', { id }, {
            found: true,
            type: item.type
        }, item.project_id, item.tenant_id);

        // Build Forensic Metadata
        const forensicMeta = await getForensicMeta(item.tenant_id, item.project_id);

        return {
            item: formattedItem,
            links: links.map(l => ({
                id: l.id,
                from_id: l.from_id,
                to_id: l.to_id,
                relation: l.relation,
                target_title: l.target_title,
                target_type: l.target_type,
                created_at: l.created_at
            })),
            meta: {
                trace_id: traceId,
                forensic: forensicMeta
            }
        };

    } catch (err) {
        logger.error('memory.get error', { error: err.message, trace_id: traceId });
        throw err;
    }
}

/**
 * Format item for response
 * @param {object} item 
 * @returns {object}
 */
function formatItem(item) {
    return {
        id: item.id,
        tenant_id: item.tenant_id,
        project_id: item.project_id,
        type: item.type,
        title: item.title,
        content: item.content,
        tags: parseJson(item.tags, []),
        verified: !!item.verified,
        confidence: item.confidence,
        usefulness_score: item.usefulness_score,
        error_count: item.error_count,
        version: item.version,
        status: item.status,
        status_reason: item.status_reason,
        created_at: item.created_at,
        updated_at: item.updated_at,
        last_used_at: item.last_used_at,
        provenance: parseJson(item.provenance_json, {}),
        content_hash: item.content_hash
    };
}

/**
 * Parse JSON safely
 * @param {string|any} value 
 * @param {any} defaultValue 
 * @returns {any}
 */
function parseJson(value, defaultValue) {
    if (!value) return defaultValue;
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch {
        return defaultValue;
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
