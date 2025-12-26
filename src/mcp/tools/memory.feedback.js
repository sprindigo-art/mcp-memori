/**
 * memory.feedback - Provide feedback on memory items
 * @module mcp/tools/memory.feedback
 */
import { query, queryOne } from '../../db/index.js';
import { recordMistake } from '../../governance/loopbreaker.js';
import { now } from '../../utils/time.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger.js';
import { getForensicMeta } from '../../utils/forensic.js';

/**
 * Tool definition for MCP
 */
export const definition = {
    name: 'memory_feedback',
    description: 'Beri feedback pada memori (useful/not_relevant/wrong)',
    inputSchema: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'Memory item ID' },
            label: {
                type: 'string',
                enum: ['useful', 'not_relevant', 'wrong'],
                description: 'Feedback label'
            },
            notes: { type: 'string', description: 'Additional notes' },
            trace_id: { type: 'string', description: 'Related trace ID' }
        },
        required: ['id', 'label']
    }
};

/**
 * Execute memory feedback
 * @param {object} params
 * @returns {Promise<object>}
 */
export async function execute(params) {
    const traceId = params.trace_id || uuidv4();
    const { id, label, notes = '', tenant_id: tenantId = 'local-user' } = params;

    try {
        // Get current item
        const item = await queryOne(
            `SELECT id, project_id, title, usefulness_score, error_count, status, verified
       FROM memory_items WHERE id = ?`,
            [id]
        );

        if (!item) {
            return {
                ok: false,
                updated: null,
                meta: { trace_id: traceId, error: 'Item not found' }
            };
        }

        let newUsefulnessScore = item.usefulness_score;
        let newErrorCount = item.error_count;
        let newStatus = item.status;
        let newVerified = item.verified;

        switch (label) {
            case 'useful':
                // Boost usefulness score
                newUsefulnessScore += 1;
                break;

            case 'not_relevant':
                // Decrease usefulness score
                newUsefulnessScore -= 0.5;
                break;

            case 'wrong':
                // Increment error count, unverify, potentially quarantine
                newErrorCount += 1;
                newVerified = 0;

                // Quarantine if error count reaches threshold
                if (newErrorCount >= 1) {
                    newStatus = 'quarantined';
                }

                // Record mistake for loop breaker
                await recordMistake({
                    projectId: item.project_id,
                    tenantId,
                    signature: `wrong:${item.title}:${id}`,
                    severity: newErrorCount >= 2 ? 'high' : 'medium',
                    notes: notes || `Marked as wrong. Error count: ${newErrorCount}`
                });
                break;
        }

        // Update item
        await query(
            `UPDATE memory_items SET 
       usefulness_score = ?,
       error_count = ?,
       status = ?,
       verified = ?,
       status_reason = CASE WHEN ? != status THEN ? ELSE status_reason END,
       updated_at = ?
       WHERE id = ?`,
            [
                newUsefulnessScore,
                newErrorCount,
                newStatus,
                newVerified,
                newStatus,
                `Feedback: ${label}. ${notes}`,
                now(),
                id
            ]
        );

        // Write audit log
        await writeAuditLog(traceId, 'memory_feedback',
            { id, label, notes },
            {
                previous: {
                    usefulness_score: item.usefulness_score,
                    error_count: item.error_count,
                    status: item.status
                },
                updated: {
                    usefulness_score: newUsefulnessScore,
                    error_count: newErrorCount,
                    status: newStatus
                }
            },
            item.project_id,
            tenantId
        );

        // Build Forensic Metadata
        const forensicMeta = await getForensicMeta(tenantId, item.project_id);

        return {
            ok: true,
            previous: {
                status: item.status,
                error_count: item.error_count,
                usefulness: item.usefulness_score
            },
            updated: {
                id,
                usefulness_score: newUsefulnessScore,
                error_count: newErrorCount,
                status: newStatus
            },
            meta: {
                trace_id: traceId,
                forensic: forensicMeta
            }
        };

    } catch (err) {
        logger.error('memory.feedback error', { error: err.message, trace_id: traceId });
        throw err;
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
