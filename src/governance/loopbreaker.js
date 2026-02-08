/**
 * Loop breaker - prevent repeated mistakes
 * @module governance/loopbreaker
 */
import { query, queryOne } from '../db/index.js';
import { contentHash } from '../utils/hash.js';
import { now, daysAgo } from '../utils/time.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger.js';
import { isProtectedItem } from './policyEngine.js';
import { createGuardrail } from './guardrails.js';

/**
 * Record a mistake
 * @param {object} params
 * @param {string} params.projectId
 * @param {string} params.tenantId
 * @param {string} params.signature - Error pattern signature
 * @param {string} params.severity - low, medium, high, critical
 * @param {string} params.notes - Description of the mistake
 * @returns {Promise<{id: string, count: number, isRepeated: boolean}>}
 */
export async function recordMistake({ projectId, tenantId, signature, severity = 'medium', notes = '' }) {
    const sigHash = contentHash(signature);

    // Check if this mistake already exists
    const existing = await queryOne(
        `SELECT id, count FROM mistakes
     WHERE tenant_id = ? AND project_id = ? AND signature = ?`,
        [tenantId, projectId, sigHash]
    );

    if (existing) {
        // Increment count
        await query(
            `UPDATE mistakes SET count = count + 1, 
       last_seen_at = ?,
       notes_json = json_insert(notes_json, '$[#]', ?)
       WHERE id = ?`,
            [now(), notes, existing.id]
        );

        return {
            id: existing.id,
            count: existing.count + 1,
            isRepeated: true
        };
    } else {
        // Create new mistake record
        const id = uuidv4();
        await query(
            `INSERT INTO mistakes (id, tenant_id, project_id, signature, count, severity, last_seen_at, notes_json)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
            [id, tenantId, projectId, sigHash, severity, now(), JSON.stringify([notes])]
        );

        return {
            id,
            count: 1,
            isRepeated: false
        };
    }
}

/**
 * Get recent mistakes in a project
 * @param {object} params
 * @param {string} params.projectId
 * @param {string} params.tenantId
 * @param {number} params.withinDays
 * @returns {Promise<Array>}
 */
export async function getRecentMistakes({ projectId, tenantId, withinDays = 7 }) {
    const since = daysAgo(withinDays);

    return query(
        `SELECT id, signature, count, severity, last_seen_at, notes_json
     FROM mistakes
     WHERE tenant_id = ? AND project_id = ? AND last_seen_at > ?
     ORDER BY count DESC, last_seen_at DESC`,
        [tenantId, projectId, since]
    );
}

/**
 * Check for repeated mistakes and take action
 * @param {object} params
 * @param {string} params.projectId
 * @param {string} params.tenantId
 * @param {number} params.threshold - Number of times before triggering
 * @param {boolean} params.dryRun
 * @returns {Promise<{mistakesUpdated: number, guardrailsAdded: boolean, quarantinedIds: string[]}>}
 */
export async function checkLoopBreaker({ projectId, tenantId, threshold = 2, dryRun = true }) {
    const result = {
        mistakesUpdated: 0,
        guardrailsAdded: false,
        quarantinedIds: []
    };

    // Get repeated mistakes
    const mistakes = await getRecentMistakes({ projectId, tenantId, withinDays: 7 });
    const repeatedMistakes = mistakes.filter(m => m.count >= threshold);

    if (repeatedMistakes.length === 0) {
        return result;
    }

    result.mistakesUpdated = repeatedMistakes.length;

    // Find related memory items from audit log
    for (const mistake of repeatedMistakes) {
        // Look for items that might have caused this mistake
        const relatedAudits = await query(
            `SELECT DISTINCT request_json 
       FROM audit_log 
       WHERE project_id = ? AND tenant_id = ?
       AND ts > ?
       ORDER BY ts DESC
       LIMIT 5`,
            [projectId, tenantId, daysAgo(7)]
        );

        // Try to extract item IDs from audit logs
        for (const audit of relatedAudits) {
            try {
                const request = JSON.parse(audit.request_json);
                if (request.id && !dryRun) {
                    // FIX: Check if item is protected before quarantining
                    const item = await queryOne(
                        `SELECT id, tags, verified, confidence FROM memory_items WHERE id = ?`,
                        [request.id]
                    );

                    if (item && isProtectedItem(item)) {
                        logger.debug('Skipping protected item in loopbreaker', { id: item.id });
                        continue; // Don't quarantine protected items
                    }

                    // Quarantine the related item only if NOT protected
                    await query(
                        `UPDATE memory_items SET status = 'quarantined',
             status_reason = 'Loop breaker: related to repeated mistake',
             updated_at = ?
             WHERE id = ? AND status = 'active'`,
                        [now(), request.id]
                    );
                    result.quarantinedIds.push(request.id);
                }
            } catch {
                // Ignore parse errors
            }
        }
    }

    // Add guardrail to BOTH: guardrails table AND state content
    if (repeatedMistakes.length > 0 && !dryRun) {
        // INSERT into guardrails table (FIX: was never inserted before!)
        for (const mistake of repeatedMistakes) {
            try {
                await createGuardrail({
                    projectId,
                    tenantId,
                    ruleType: 'warn',
                    pattern: mistake.signature || mistake.notes || 'repeated_mistake',
                    description: `Auto-guardrail: Repeated mistake (${mistake.count}x in 7d) - ${mistake.notes || mistake.signature}`,
                    suppressIds: result.quarantinedIds,
                    expiresInDays: 30
                });
            } catch (err) {
                logger.warn('Failed to create guardrail from loopbreaker', { error: err.message });
            }
        }

        // Also append to state content (legacy behavior)
        await addGuardrailToState({
            projectId,
            tenantId,
            guardrail: `PERHATIAN: ${repeatedMistakes.length} kesalahan berulang terdeteksi dalam 7 hari terakhir. Periksa mistakes table.`
        });
        result.guardrailsAdded = true;
    }

    return result;
}

/**
 * Add guardrail to current state
 * @param {object} params
 * @param {string} params.projectId
 * @param {string} params.tenantId
 * @param {string} params.guardrail
 * @returns {Promise<void>}
 */
async function addGuardrailToState({ projectId, tenantId, guardrail }) {
    // Get latest state
    const state = await queryOne(
        `SELECT id, content FROM memory_items
     WHERE tenant_id = ? AND project_id = ? AND type = 'state' AND status = 'active'
     ORDER BY updated_at DESC LIMIT 1`,
        [tenantId, projectId]
    );

    if (state) {
        // Append guardrail to content
        const newContent = state.content + `\n\n## GUARDRAIL\n${guardrail}`;
        await query(
            `UPDATE memory_items SET content = ?, version = version + 1, updated_at = ?
       WHERE id = ?`,
            [newContent, now(), state.id]
        );
    } else {
        // Create new state with guardrail
        await query(
            `INSERT INTO memory_items (id, tenant_id, project_id, type, title, content, content_hash, created_at, updated_at)
       VALUES (?, ?, ?, 'state', 'Current State', ?, ?, ?, ?)`,
            [uuidv4(), tenantId, projectId, `## GUARDRAIL\n${guardrail}`, contentHash(`## GUARDRAIL\n${guardrail}`), now(), now()]
        );
    }
}

export default { recordMistake, getRecentMistakes, checkLoopBreaker };
