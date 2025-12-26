/**
 * memory.forget - Soft delete memory items
 * @module mcp/tools/memory.forget
 */
import { query, queryOne } from '../../db/index.js';
import { withLock } from '../../concurrency/lock.js';
import { now, daysAgo } from '../../utils/time.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger.js';
import { getForensicMeta } from '../../utils/forensic.js';

/**
 * Tool definition for MCP
 */
export const definition = {
    name: 'memory_forget',
    description: 'Soft-delete memori dengan alasan',
    inputSchema: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'Memory item ID (untuk single delete)' },
            selector: {
                type: 'object',
                properties: {
                    project_id: { type: 'string', description: 'Project ID' },
                    type: { type: 'string', description: 'Memory type filter' },
                    tag: { type: 'string', description: 'Tag filter' },
                    older_than: { type: 'number', description: 'Items older than N days' }
                },
                description: 'Selector untuk bulk delete'
            },
            reason: { type: 'string', description: 'Reason for deletion' }
        },
        required: ['reason']
    }
};

/**
 * Execute memory forget
 * @param {object} params
 * @returns {Promise<object>}
 */
export async function execute(params) {
    const traceId = uuidv4();
    const { id, selector, reason, tenant_id: tenantId = 'local-user' } = params;

    if (!id && !selector) {
        return {
            ok: false,
            affected: [],
            meta: { trace_id: traceId, error: 'Must provide id or selector' }
        };
    }

    try {
        let affected = [];

        if (id) {
            // Single item delete
            affected = await forgetById(id, reason, tenantId);
        } else {
            // Bulk delete by selector
            affected = await forgetBySelector(selector, reason, tenantId);
        }

        // Write audit log
        const projectId = selector?.project_id || (affected[0] ?
            (await queryOne(`SELECT project_id FROM memory_items WHERE id = ?`, [affected[0]]))?.project_id :
            'unknown');

        await writeAuditLog(traceId, 'memory_forget',
            { id, selector, reason },
            { affected_count: affected.length },
            projectId,
            tenantId
        );

        // Build Forensic Metadata
        const forensicMeta = await getForensicMeta(tenantId, projectId || 'unknown');

        return {
            ok: true,
            affected,
            meta: {
                trace_id: traceId,
                forensic: forensicMeta
            }
        };

    } catch (err) {
        logger.error('memory.forget error', { error: err.message, trace_id: traceId });
        throw err;
    }
}

/**
 * Forget single item by ID
 * @param {string} id 
 * @param {string} reason 
 * @param {string} tenantId 
 * @returns {Promise<string[]>}
 */
async function forgetById(id, reason, tenantId) {
    // Check if item exists
    const item = await queryOne(
        `SELECT id, project_id FROM memory_items WHERE id = ? AND tenant_id = ?`,
        [id, tenantId]
    );

    if (!item) {
        return [];
    }

    return withLock(`forget:${item.project_id}`, async () => {
        await query(
            `UPDATE memory_items SET 
       status = 'deleted',
       status_reason = ?,
       updated_at = ?
       WHERE id = ?`,
            [reason, now(), id]
        );

        return [id];
    });
}

/**
 * Forget items by selector
 * @param {object} selector 
 * @param {string} reason 
 * @param {string} tenantId 
 * @returns {Promise<string[]>}
 */
async function forgetBySelector(selector, reason, tenantId) {
    const { project_id: projectId, type, tag, older_than: olderThan } = selector;

    if (!projectId) {
        throw new Error('selector.project_id is required for bulk forget');
    }

    return withLock(`forget:${projectId}`, async () => {
        // Build query
        let sql = `SELECT id FROM memory_items WHERE tenant_id = ? AND project_id = ? AND status != 'deleted'`;
        const params = [tenantId, projectId];

        if (type) {
            sql += ` AND type = ?`;
            params.push(type);
        }

        if (tag) {
            sql += ` AND tags LIKE ?`;
            params.push(`%"${tag}"%`);
        }

        if (olderThan) {
            const cutoff = daysAgo(olderThan);
            sql += ` AND created_at < ?`;
            params.push(cutoff);
        }

        const items = await query(sql, params);
        const ids = items.map(i => i.id);

        if (ids.length === 0) {
            return [];
        }

        // Update all matching items
        const placeholders = ids.map(() => '?').join(',');
        await query(
            `UPDATE memory_items SET 
       status = 'deleted',
       status_reason = ?,
       updated_at = ?
       WHERE id IN (${placeholders})`,
            [reason, now(), ...ids]
        );

        return ids;
    });
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
