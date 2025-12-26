/**
 * memory.maintain - Comprehensive maintenance tool
 * @module mcp/tools/memory.maintain
 */
import { query } from '../../db/index.js';
import { withLock } from '../../concurrency/lock.js';
import { mergePolicy } from '../../governance/policyEngine.js';
import { pruneItems, pruneOldEpisodes } from '../../governance/prune.js';
import { deduplicateItems, detectConflicts } from '../../governance/conflict.js';
import { checkLoopBreaker } from '../../governance/loopbreaker.js';
import { contentHash } from '../../utils/hash.js';
import { now } from '../../utils/time.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger.js';
import { getForensicMeta } from '../../utils/forensic.js';

/**
 * Tool definition for MCP
 */
export const definition = {
    name: 'memory_maintain',
    description: 'Maintenance: dedup, conflict detection, prune, compact, loopbreaker',
    inputSchema: {
        type: 'object',
        properties: {
            project_id: { type: 'string', description: 'Project ID' },
            mode: {
                type: 'string',
                enum: ['dry_run', 'apply'],
                description: 'Mode: dry_run (preview) or apply (execute)'
            },
            actions: {
                type: 'array',
                items: { type: 'string' },
                description: 'Actions: dedup, conflict, prune, compact, loopbreak'
            },
            policy: {
                type: 'object',
                properties: {
                    max_age_days: { type: 'number' },
                    min_usefulness: { type: 'number' },
                    max_error_count: { type: 'number' },
                    keep_last_n_episodes: { type: 'number' },
                    quarantine_on_wrong_threshold: { type: 'number' },
                    delete_on_wrong_threshold: { type: 'number' }
                },
                description: 'Governance policy overrides'
            }
        },
        required: ['project_id']
    }
};

/**
 * Execute memory maintain
 * @param {object} params
 * @returns {Promise<object>}
 */
export async function execute(params) {
    const traceId = uuidv4();
    const {
        project_id: projectId,
        tenant_id: tenantId = 'local-user',
        mode = 'dry_run',
        actions = ['dedup', 'conflict', 'prune', 'compact', 'loopbreak'],
        policy: userPolicy = {}
    } = params;

    const dryRun = mode === 'dry_run';
    const policy = mergePolicy(userPolicy);

    const result = {
        dry_run: dryRun,
        actions_planned_or_done: {
            dedup: { merged: [] },
            conflict: { conflicts: [], links_added: 0 },
            prune: { quarantined: [], deleted: [], deprecated: [] },
            compact: { episodes_pruned: [] },
            loopbreak: { mistakes_updated: 0, guardrails_added: false }
        },
        meta: { trace_id: traceId }
    };

    try {
        // Acquire lock for this project
        await withLock(`maintain:${projectId}`, async () => {

            // 1. Deduplication
            if (actions.includes('dedup')) {
                logger.debug('Running dedup', { projectId, dryRun });
                const dedupResult = await deduplicateItems({
                    projectId,
                    tenantId,
                    dryRun
                });
                result.actions_planned_or_done.dedup = dedupResult;
            }

            // 2. Conflict detection
            if (actions.includes('conflict')) {
                logger.debug('Running conflict detection', { projectId, dryRun });
                const conflictResult = await detectConflicts({
                    projectId,
                    tenantId,
                    dryRun
                });
                result.actions_planned_or_done.conflict = conflictResult;
            }

            // 3. Prune based on policy
            if (actions.includes('prune')) {
                logger.debug('Running prune', { projectId, dryRun, policy });
                const pruneResult = await pruneItems({
                    projectId,
                    tenantId,
                    policy,
                    dryRun
                });
                result.actions_planned_or_done.prune = pruneResult;
            }

            // 4. Compact old episodes
            if (actions.includes('compact')) {
                logger.debug('Running compact', { projectId, dryRun });

                // Prune old episodes
                const episodeResult = await pruneOldEpisodes({
                    projectId,
                    tenantId,
                    keepLastN: policy.keep_last_n_episodes,
                    dryRun
                });
                result.actions_planned_or_done.compact.episodes_pruned = episodeResult.pruned;

                // Optionally: summarize old episodes into state
                // This would require more complex logic to merge episode content
                // For now, we just prune them
            }

            // 5. Loop breaker
            if (actions.includes('loopbreak')) {
                logger.debug('Running loopbreak', { projectId, dryRun });
                const loopResult = await checkLoopBreaker({
                    projectId,
                    tenantId,
                    threshold: 2,
                    dryRun
                });
                result.actions_planned_or_done.loopbreak = {
                    mistakes_updated: loopResult.mistakesUpdated,
                    guardrails_added: loopResult.guardrailsAdded,
                    quarantined: loopResult.quarantinedIds
                };
            }

        });

        // Build Forensic Metadata
        result.meta.forensic = await getForensicMeta(tenantId, projectId);

        // Write audit log
        await writeAuditLog(traceId, 'memory_maintain',
            { project_id: projectId, mode, actions, policy: userPolicy },
            summarizeResult(result.actions_planned_or_done),
            projectId,
            tenantId
        );

        return result;

    } catch (err) {
        logger.error('memory.maintain error', { error: err.message, trace_id: traceId });
        throw err;
    }
}

/**
 * Summarize result for audit log
 * @param {object} actions 
 * @returns {object}
 */
function summarizeResult(actions) {
    return {
        dedup_merged: actions.dedup.merged?.length || 0,
        conflicts_found: actions.conflict.conflicts?.length || 0,
        prune_quarantined: actions.prune.quarantined?.length || 0,
        prune_deleted: actions.prune.deleted?.length || 0,
        prune_deprecated: actions.prune.deprecated?.length || 0,
        episodes_pruned: actions.compact.episodes_pruned?.length || 0,
        loopbreak_updated: actions.loopbreak.mistakes_updated || 0
    };
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
