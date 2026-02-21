/**
 * Prune operations for memory maintenance
 * @module governance/prune
 */
import { query, transaction } from '../db/index.js';
import { evaluateItem, getSafeAction, isProtectedItem } from './policyEngine.js';
import { now } from '../utils/time.js';
import logger from '../utils/logger.js';

/**
 * Prune items based on policy
 * @param {object} params
 * @param {string} params.projectId
 * @param {string} params.tenantId
 * @param {object} params.policy
 * @param {boolean} params.dryRun
 * @returns {Promise<{quarantined: string[], deleted: string[], deprecated: string[]}>}
 */
export async function pruneItems({ projectId, tenantId, policy, dryRun = true }) {
    const result = {
        quarantined: [],
        deleted: [],
        deprecated: []
    };

    // Get active items (include tags, verified, confidence for protection check)
    const items = await query(
        `SELECT id, type, tags, verified, confidence, error_count, usefulness_score, created_at, updated_at
     FROM memory_items
     WHERE tenant_id = ? AND project_id = ? AND status = 'active'`,
        [tenantId, projectId]
    );

    for (const item of items) {
        const evaluation = evaluateItem(item, policy);

        if (!evaluation.action) continue;

        const safeAction = getSafeAction(item.type, evaluation.action);

        logger.debug('Prune evaluation', {
            id: item.id,
            type: item.type,
            action: safeAction,
            reason: evaluation.reason
        });

        if (!dryRun) {
            // Apply action
            if (safeAction === 'deleted') {
                await query(
                    `UPDATE memory_items SET status = 'deleted', status_reason = ?, updated_at = ?
           WHERE id = ?`,
                    [evaluation.reason, now(), item.id]
                );
                result.deleted.push(item.id);
            } else if (safeAction === 'quarantined') {
                await query(
                    `UPDATE memory_items SET status = 'quarantined', status_reason = ?, updated_at = ?
           WHERE id = ?`,
                    [evaluation.reason, now(), item.id]
                );
                result.quarantined.push(item.id);
            } else if (safeAction === 'deprecated') {
                await query(
                    `UPDATE memory_items SET status = 'deprecated', status_reason = ?, updated_at = ?
           WHERE id = ?`,
                    [evaluation.reason, now(), item.id]
                );
                result.deprecated.push(item.id);
            }
        } else {
            // Dry run: just collect
            if (safeAction === 'deleted') result.deleted.push(item.id);
            else if (safeAction === 'quarantined') result.quarantined.push(item.id);
            else if (safeAction === 'deprecated') result.deprecated.push(item.id);
        }
    }

    // FIX #3: Auto-delete quarantined items that exceed error threshold
    const deleteThreshold = policy.delete_on_wrong_threshold || 3;

    const quarantinedItems = await query(
        `SELECT id, type, error_count 
         FROM memory_items
         WHERE tenant_id = ? AND project_id = ? AND status = 'quarantined' 
         AND error_count >= ?`,
        [tenantId, projectId, deleteThreshold]
    );

    for (const item of quarantinedItems) {
        // SAFE RULES: Only runbook and episode can be auto-deleted
        // decision -> deprecated, state -> superseded (not auto-deleted)
        const canAutoDelete = ['runbook', 'episode', 'fact'].includes(item.type);

        if (canAutoDelete) {
            const reason = `Auto-deleted: error_count (${item.error_count}) >= threshold (${deleteThreshold})`;

            if (!dryRun) {
                await query(
                    `UPDATE memory_items SET status = 'deleted', status_reason = ?, updated_at = ?
                     WHERE id = ?`,
                    [reason, now(), item.id]
                );
            }
            result.deleted.push(item.id);

            logger.info('Auto-delete triggered', {
                id: item.id,
                type: item.type,
                error_count: item.error_count,
                threshold: deleteThreshold
            });
        } else if (item.type === 'decision') {
            // Decisions get deprecated instead of deleted
            const reason = `Auto-deprecated: error_count (${item.error_count}) >= threshold (${deleteThreshold})`;

            if (!dryRun) {
                await query(
                    `UPDATE memory_items SET status = 'deprecated', status_reason = ?, updated_at = ?
                     WHERE id = ?`,
                    [reason, now(), item.id]
                );
            }
            result.deprecated.push(item.id);
        }
        // state type: do not auto-delete or deprecate (requires manual supersede)
    }

    return result;
}

/**
 * Prune old episodes, keeping only last N
 * @param {object} params
 * @param {string} params.projectId
 * @param {string} params.tenantId
 * @param {number} params.keepLastN
 * @param {boolean} params.dryRun
 * @returns {Promise<{pruned: string[]}>}
 */
export async function pruneOldEpisodes({ projectId, tenantId, keepLastN = 500, dryRun = true }) {
    const result = { pruned: [] };

    // Get episodes ordered by creation date
    const episodes = await query(
        `SELECT id, tags, verified, confidence, usefulness_score FROM memory_items
     WHERE tenant_id = ? AND project_id = ? AND type = 'episode' 
     AND status = 'active'
     ORDER BY created_at DESC`,
        [tenantId, projectId]
    );

    // Episodes beyond keepLastN (candidates for pruning)
    const candidates = episodes.slice(keepLastN);

    if (candidates.length === 0) return result;

    for (const episode of candidates) {
        // CRITICAL: Skip protected items (with critical tags, verified, high confidence)
        if (isProtectedItem(episode)) {
            logger.debug('Skipping protected episode from pruning', { id: episode.id });
            continue;
        }

        if (!dryRun) {
            await query(
                `UPDATE memory_items SET status = 'deleted', 
         status_reason = 'Pruned: exceeds keep_last_n_episodes limit',
         updated_at = ?
         WHERE id = ?`,
                [now(), episode.id]
            );
        }
        result.pruned.push(episode.id);
    }

    return result;
}

export default { pruneItems, pruneOldEpisodes };
