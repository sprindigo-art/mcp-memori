/**
 * memory.maintain - Comprehensive maintenance tool
 * v4.0 - Added archive + consolidate actions + cache clearing
 * @module mcp/tools/memory.maintain
 */
import { query } from '../../db/index.js';
import { withLock } from '../../concurrency/lock.js';
import { mergePolicy } from '../../governance/policyEngine.js';
import { pruneItems, pruneOldEpisodes } from '../../governance/prune.js';
import { deduplicateItems, detectConflicts } from '../../governance/conflict.js';
import { checkLoopBreaker } from '../../governance/loopbreaker.js';
import { createGuardrail } from '../../governance/guardrails.js';
import { cosineSimilarity } from '../../utils/embedding.js';
import { clearCache } from '../../utils/cache.js';
import { contentHash } from '../../utils/hash.js';
import { now } from '../../utils/time.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger.js';
import { getForensicMeta } from '../../utils/forensic.js'; // now compact by default (v4.0)

/**
 * Tool definition for MCP
 */
export const definition = {
    name: 'memory_maintain',
    description: 'Maintenance: dedup, conflict, prune, compact, loopbreak, clean_links, auto_guardrails, archive, consolidate, rebuild_fts, wal_checkpoint, vacuum',
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
                description: 'Actions: dedup, conflict, prune, compact, loopbreak, clean_links, auto_guardrails, archive, consolidate, rebuild_fts, wal_checkpoint, vacuum'
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
            loopbreak: { mistakes_updated: 0, guardrails_added: false },
            clean_links: { orphans_removed: 0, dupes_removed: 0 },
            auto_guardrails: { scanned: 0, created: 0, patterns: [] },
            archive: { archived: 0, items: [] },
            consolidate: { clusters_found: 0, facts_created: 0, episodes_archived: 0 }
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

            // 6. Clean orphan & duplicate links
            if (actions.includes('clean_links')) {
                logger.debug('Running clean_links', { projectId, dryRun });

                // Count orphan links before cleanup
                const orphanCount = await query(
                    `SELECT COUNT(*) as cnt FROM memory_links l 
                     WHERE NOT EXISTS (SELECT 1 FROM memory_items m WHERE m.id = l.from_id AND m.status='active') 
                        OR NOT EXISTS (SELECT 1 FROM memory_items m WHERE m.id = l.to_id AND m.status='active')`
                );
                const orphans = orphanCount[0]?.cnt || 0;

                // Count duplicate links (same from_id + to_id + relation)
                const dupeCount = await query(
                    `SELECT COUNT(*) as cnt FROM (
                        SELECT from_id, to_id, relation, COUNT(*) as c 
                        FROM memory_links GROUP BY from_id, to_id, relation HAVING c > 1
                    )`
                );
                const dupes = dupeCount[0]?.cnt || 0;

                if (!dryRun) {
                    // Delete orphan links
                    if (orphans > 0) {
                        await query(
                            `DELETE FROM memory_links WHERE id IN (
                                SELECT l.id FROM memory_links l 
                                WHERE NOT EXISTS (SELECT 1 FROM memory_items m WHERE m.id = l.from_id AND m.status='active') 
                                   OR NOT EXISTS (SELECT 1 FROM memory_items m WHERE m.id = l.to_id AND m.status='active')
                            )`
                        );
                    }

                    // Delete duplicate links (keep oldest)
                    if (dupes > 0) {
                        await query(
                            `DELETE FROM memory_links WHERE id NOT IN (
                                SELECT MIN(id) FROM memory_links GROUP BY from_id, to_id, relation
                            )`
                        );
                    }
                }

                result.actions_planned_or_done.clean_links = {
                    orphans_removed: orphans,
                    dupes_removed: dupes
                };
            }

            // 7. Auto-populate guardrails from decision items
            if (actions.includes('auto_guardrails')) {
                logger.debug('Running auto_guardrails', { projectId, dryRun });

                // Scan decision items with guardrail-related tags or titles
                const guardrailDecisions = await query(
                    `SELECT id, title, content, tags FROM memory_items 
                     WHERE tenant_id = ? AND project_id = ? AND status = 'active'
                     AND type = 'decision'
                     AND (
                         tags LIKE '%guardrail%' OR tags LIKE '%banned%' OR tags LIKE '%forbidden%'
                         OR tags LIKE '%never%' OR tags LIKE '%critical%' OR tags LIKE '%violation%'
                         OR title LIKE '%GUARDRAIL%' OR title LIKE '%FORBIDDEN%' OR title LIKE '%BANNED%'
                         OR title LIKE '%NEVER%' OR title LIKE '%DO NOT REPEAT%'
                     )
                     ORDER BY updated_at DESC LIMIT 50`,
                    [tenantId, projectId]
                );

                let created = 0;
                const patterns = [];

                for (const decision of guardrailDecisions) {
                    // Extract CVE patterns (e.g., CVE-2024-1086)
                    const cveMatches = (decision.content || '').match(/CVE-\d{4}-\d{4,}/g) || [];
                    // Extract technique keywords from title
                    const titlePatterns = [];
                    if (/kernel.*(exploit|crash)/i.test(decision.title)) titlePatterns.push('kernel_exploit_production');
                    if (/pkill/i.test(decision.title)) titlePatterns.push('pkill_command');
                    if (/iodined/i.test(decision.title)) titlePatterns.push('iodined_restart');
                    if (/cloaking/i.test(decision.title)) titlePatterns.push('cloaking_technique');
                    if (/rm\s*-rf/i.test(decision.content)) titlePatterns.push('rm_rf_destructive');

                    const allPatterns = [...new Set([...cveMatches, ...titlePatterns])];

                    for (const pattern of allPatterns) {
                        if (!dryRun) {
                            try {
                                const result = await createGuardrail({
                                    projectId,
                                    tenantId,
                                    ruleType: 'warn',
                                    pattern: `GUARDRAIL:${pattern}`,
                                    description: `[AUTO] ${decision.title} — Pattern: ${pattern}`,
                                    suppressIds: [decision.id],
                                    expiresInDays: 90
                                });
                                if (result.created) created++;
                            } catch (err) {
                                logger.warn('Failed to create auto-guardrail', { pattern, error: err.message });
                            }
                        }
                        patterns.push(pattern);
                    }
                }

                result.actions_planned_or_done.auto_guardrails = {
                    scanned: guardrailDecisions.length,
                    created,
                    patterns
                };
            }

            // 8. Auto-archive old unused items (v4.0)
            if (actions.includes('archive')) {
                logger.debug('Running archive', { projectId, dryRun });

                // Find items older than 180 days, never accessed, with safe exceptions
                const archiveCandidates = await query(
                    `SELECT id, title, type, tags, created_at, last_used_at 
                     FROM memory_items 
                     WHERE tenant_id = ? AND project_id = ? AND status = 'active'
                     AND created_at < datetime('now', '-180 days')
                     AND (last_used_at IS NULL OR last_used_at = created_at)
                     AND type NOT IN ('fact', 'decision')
                     AND tags NOT LIKE '%critical%'
                     AND tags NOT LIKE '%guardrail%'
                     AND tags NOT LIKE '%credential%'
                     ORDER BY created_at ASC LIMIT 100`,
                    [tenantId, projectId]
                );

                // Also exclude items that have links (they're referenced by others)
                const toArchive = [];
                for (const candidate of archiveCandidates) {
                    const linkCount = await query(
                        `SELECT COUNT(*) as cnt FROM memory_links WHERE from_id = ? OR to_id = ?`,
                        [candidate.id, candidate.id]
                    );
                    if ((linkCount[0]?.cnt || 0) === 0) {
                        toArchive.push(candidate);
                    }
                }

                if (!dryRun && toArchive.length > 0) {
                    const ids = toArchive.map(i => i.id);
                    const placeholders = ids.map(() => '?').join(',');
                    await query(
                        `UPDATE memory_items SET status = 'deprecated', status_reason = 'auto-archive: >180 days, never accessed', updated_at = datetime('now') WHERE id IN (${placeholders})`,
                        ids
                    );
                }

                result.actions_planned_or_done.archive = {
                    archived: toArchive.length,
                    items: toArchive.map(i => ({ id: i.id, title: i.title, age: i.created_at }))
                };
            }

            // 9. Consolidate similar episodes using cosine similarity (v4.0)
            if (actions.includes('consolidate')) {
                logger.debug('Running consolidate', { projectId, dryRun });

                const SIMILARITY_THRESHOLD = 0.85;
                let clustersFound = 0;
                let factsCreated = 0;
                let episodesArchived = 0;

                // Fetch recent episodes with embeddings (limited batch for O(n^2) safety)
                const episodes = await query(
                    `SELECT id, title, content, tags, embedding, created_at 
                     FROM memory_items 
                     WHERE tenant_id = ? AND project_id = ? AND status = 'active' 
                     AND type = 'episode' AND embedding IS NOT NULL
                     ORDER BY created_at DESC LIMIT 100`,
                    [tenantId, projectId]
                );

                // Pairwise cosine similarity clustering
                const clustered = new Set();
                const clusters = [];

                for (let i = 0; i < episodes.length; i++) {
                    if (clustered.has(episodes[i].id)) continue;
                    const cluster = [episodes[i]];
                    let embedding_i;
                    try { embedding_i = JSON.parse(episodes[i].embedding); } catch { continue; }

                    for (let j = i + 1; j < episodes.length; j++) {
                        if (clustered.has(episodes[j].id)) continue;
                        let embedding_j;
                        try { embedding_j = JSON.parse(episodes[j].embedding); } catch { continue; }

                        const similarity = cosineSimilarity(embedding_i, embedding_j);
                        if (similarity >= SIMILARITY_THRESHOLD) {
                            cluster.push(episodes[j]);
                            clustered.add(episodes[j].id);
                        }
                    }

                    // Only process clusters with 3+ items
                    if (cluster.length >= 3) {
                        clustered.add(cluster[0].id);
                        clusters.push(cluster);
                    }
                }

                clustersFound = clusters.length;

                // For each cluster: create summary fact and archive episodes
                if (!dryRun) {
                    for (const cluster of clusters) {
                        const titles = cluster.map(e => e.title).join(' | ');
                        const summaryTitle = `[CONSOLIDATED] ${cluster.length} similar episodes: ${titles.substring(0, 100)}`;

                        // Check if consolidated fact already exists
                        const exists = await query(
                            `SELECT id FROM memory_items WHERE title LIKE ? AND type = 'fact' AND status = 'active' LIMIT 1`,
                            [`%${titles.substring(0, 50)}%`]
                        );

                        if (exists.length === 0) {
                            const { v4: uuid4 } = await import('uuid');
                            const id = uuid4();
                            const { contentHash } = await import('../../utils/hash.js');
                            const summaryContent = cluster.map(e => `- ${e.title} (${e.created_at})`).join('\n');

                            await query(
                                `INSERT INTO memory_items (id, tenant_id, project_id, type, title, content, tags, status, content_hash, created_at, updated_at, last_used_at)
                                 VALUES (?, ?, ?, 'fact', ?, ?, '[]', 'active', ?, datetime('now'), datetime('now'), datetime('now'))`,
                                [id, tenantId, projectId, summaryTitle, summaryContent, contentHash(summaryContent)]
                            );
                            factsCreated++;

                            // Deprecate the clustered episodes (keep the first one active)
                            const toArchiveIds = cluster.slice(1).map(e => e.id);
                            if (toArchiveIds.length > 0) {
                                const placeholders = toArchiveIds.map(() => '?').join(',');
                                await query(
                                    `UPDATE memory_items SET status = 'deprecated', status_reason = 'consolidated into fact' WHERE id IN (${placeholders})`,
                                    toArchiveIds
                                );
                                episodesArchived += toArchiveIds.length;
                            }
                        }
                    }
                }

                result.actions_planned_or_done.consolidate = {
                    clusters_found: clustersFound,
                    facts_created: factsCreated,
                    episodes_archived: episodesArchived,
                    preview: clusters.map(c => ({
                        size: c.length,
                        sample_titles: c.slice(0, 3).map(e => e.title)
                    }))
                };
            }

            // 10. Audit Log Rotation (v5.2) — prevent unbounded growth
            if (actions.includes('audit_trim')) {
                logger.debug('Running audit_trim', { projectId, dryRun });

                const MAX_AUDIT_ENTRIES = 5000;
                const countResult = await query(`SELECT COUNT(*) as cnt FROM audit_log`);
                const totalAudit = countResult[0]?.cnt || 0;

                let trimmed = 0;
                if (totalAudit > MAX_AUDIT_ENTRIES) {
                    const excess = totalAudit - MAX_AUDIT_ENTRIES;
                    if (!dryRun) {
                        await query(
                            `DELETE FROM audit_log WHERE id IN (
                                SELECT id FROM audit_log ORDER BY ts ASC LIMIT ?
                            )`,
                            [excess]
                        );
                    }
                    trimmed = excess;
                }

                result.actions_planned_or_done.audit_trim = {
                    total_before: totalAudit,
                    trimmed,
                    remaining: totalAudit - trimmed,
                    max_allowed: MAX_AUDIT_ENTRIES
                };
            }

            // 11. Cross-Type Overlap Detection (v5.2) — find STATE vs FACT duplicates
            if (actions.includes('cross_type_overlap')) {
                logger.debug('Running cross_type_overlap', { projectId, dryRun });

                // Get recent active items for overlap check (limit scope for performance)
                const candidates = await query(
                    `SELECT id, title, type, tags, updated_at FROM memory_items 
                     WHERE tenant_id = ? AND project_id = ? AND status = 'active'
                     AND type IN ('fact', 'state')
                     ORDER BY updated_at DESC LIMIT 200`,
                    [tenantId, projectId]
                );

                const overlaps = [];
                const checked = new Set();

                for (let i = 0; i < candidates.length; i++) {
                    if (checked.has(candidates[i].id)) continue;
                    const titleI = (candidates[i].title || '').toLowerCase();
                    const wordsI = titleI.split(/[\s\-_\[\]]+/).filter(w => w.length >= 3);
                    const setI = new Set(wordsI);
                    if (setI.size < 2) continue;

                    for (let j = i + 1; j < candidates.length; j++) {
                        if (checked.has(candidates[j].id)) continue;
                        if (candidates[i].type === candidates[j].type) continue; // skip same-type (handled by regular dedup)

                        const titleJ = (candidates[j].title || '').toLowerCase();
                        const wordsJ = titleJ.split(/[\s\-_\[\]]+/).filter(w => w.length >= 3);
                        const setJ = new Set(wordsJ);
                        if (setJ.size < 2) continue;

                        // Jaccard similarity on title words
                        const intersection = [...setI].filter(w => setJ.has(w)).length;
                        const union = new Set([...setI, ...setJ]).size;
                        const jaccard = intersection / union;

                        if (jaccard >= 0.55) {
                            overlaps.push({
                                id1: candidates[i].id,
                                type1: candidates[i].type,
                                title1: candidates[i].title,
                                id2: candidates[j].id,
                                type2: candidates[j].type,
                                title2: candidates[j].title,
                                overlap_score: Math.round(jaccard * 100) / 100
                            });
                            // Don't mark as checked — one item could overlap with multiple
                        }
                    }
                }

                result.actions_planned_or_done.cross_type_overlap = {
                    scanned: candidates.length,
                    overlaps_found: overlaps.length,
                    overlaps: overlaps.slice(0, 20) // Cap output at 20
                };
            }

            // 12. REBUILD FTS INDEX (v5.2) — fix ghost entries from deleted/quarantined items
            if (actions.includes('rebuild_fts')) {
                logger.debug('Running rebuild_fts', { projectId, dryRun });

                let removed = 0;
                let rebuilt = 0;

                // Count current FTS entries vs active items
                const ftsCount = await query(`SELECT COUNT(*) as cnt FROM memory_items_fts`);
                const activeCount = await query(
                    `SELECT COUNT(*) as cnt FROM memory_items WHERE status = 'active'`
                );
                const currentFts = ftsCount[0]?.cnt || 0;
                const currentActive = activeCount[0]?.cnt || 0;
                removed = Math.max(0, currentFts - currentActive);

                if (!dryRun) {
                    // Delete ALL FTS content
                    await query(`DELETE FROM memory_items_fts`);

                    // Re-insert only active items (standalone FTS: id, title, content)
                    const activeItems = await query(
                        `SELECT id, title, content FROM memory_items WHERE status = 'active'`
                    );

                    for (const item of activeItems) {
                        await query(
                            `INSERT INTO memory_items_fts(id, title, content) VALUES (?, ?, ?)`,
                            [item.id, item.title, item.content]
                        );
                    }
                    rebuilt = activeItems.length;
                } else {
                    rebuilt = currentActive;
                }

                result.actions_planned_or_done.rebuild_fts = {
                    executed: !dryRun,
                    ghost_entries_removed: removed,
                    active_entries_rebuilt: rebuilt
                };
            }

            // 13. WAL CHECKPOINT (v5.2) — reduce WAL file size
            if (actions.includes('wal_checkpoint')) {
                logger.debug('Running wal_checkpoint', { projectId, dryRun });

                let walSize = 0;
                if (!dryRun) {
                    try {
                        const result_wal = await query(`PRAGMA wal_checkpoint(TRUNCATE)`);
                        walSize = result_wal[0]?.busy || 0;
                    } catch (walErr) {
                        logger.warn('WAL checkpoint failed', { error: walErr.message });
                    }
                }

                result.actions_planned_or_done.wal_checkpoint = {
                    executed: !dryRun,
                    busy: walSize
                };
            }

            // 14. VACUUM (v5.2) — reclaim disk space after deletions
            if (actions.includes('vacuum')) {
                logger.debug('Running vacuum', { projectId, dryRun });

                let freed = 0;
                if (!dryRun) {
                    const beforeSize = await query(`SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()`);
                    const beforeBytes = beforeSize[0]?.size || 0;
                    await query(`VACUUM`);
                    const afterSize = await query(`SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()`);
                    const afterBytes = afterSize[0]?.size || 0;
                    freed = Math.max(0, beforeBytes - afterBytes);
                }

                const freelistResult = await query(`PRAGMA freelist_count`);
                result.actions_planned_or_done.vacuum = {
                    executed: !dryRun,
                    bytes_freed: freed,
                    freelist_pages_remaining: freelistResult[0]?.freelist_count || 0
                };
            }

            // Clear cache after maintenance (any data may have changed)
            clearCache();

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
        loopbreak_updated: actions.loopbreak.mistakes_updated || 0,
        orphan_links_removed: actions.clean_links?.orphans_removed || 0,
        dupe_links_removed: actions.clean_links?.dupes_removed || 0,
        auto_guardrails_created: actions.auto_guardrails?.created || 0
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
