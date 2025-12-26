/**
 * Conflict detection and deduplication
 * @module governance/conflict
 */
import { query, transaction } from '../db/index.js';
import { contentHash } from '../utils/hash.js';
import { extractKeywords, normalizeText } from '../utils/normalize.js';
import { now } from '../utils/time.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger.js';

/**
 * Find and merge duplicate items
 * @param {object} params
 * @param {string} params.projectId
 * @param {string} params.tenantId
 * @param {boolean} params.dryRun
 * @returns {Promise<{merged: Array<{keptId: string, removedIds: string[]}>}>}
 */
export async function deduplicateItems({ projectId, tenantId, dryRun = true }) {
    const result = { merged: [] };

    // Find items with same content_hash
    const duplicates = await query(
        `SELECT content_hash, COUNT(*) as cnt
     FROM memory_items
     WHERE tenant_id = ? AND project_id = ? AND status = 'active'
     GROUP BY content_hash
     HAVING COUNT(*) > 1`,
        [tenantId, projectId]
    );

    for (const dup of duplicates) {
        // Get all items with this hash
        const items = await query(
            `SELECT id, version, usefulness_score, verified, created_at, updated_at
       FROM memory_items
       WHERE tenant_id = ? AND project_id = ? AND content_hash = ? AND status = 'active'
       ORDER BY 
         verified DESC,           
         usefulness_score DESC,   
         version DESC,           
         updated_at DESC`,
            [tenantId, projectId, dup.content_hash]
        );

        if (items.length < 2) continue;

        // Keep the best one (first after sorting)
        const keep = items[0];
        const remove = items.slice(1);

        if (!dryRun) {
            // Merge: soft-delete duplicates
            for (const item of remove) {
                await query(
                    `UPDATE memory_items SET status = 'deleted', 
           status_reason = 'Merged: duplicate of ${keep.id}',
           updated_at = ?
           WHERE id = ?`,
                    [now(), item.id]
                );
            }

            // Update kept item version
            await query(
                `UPDATE memory_items SET version = version + 1, updated_at = ? WHERE id = ?`,
                [now(), keep.id]
            );
        }

        result.merged.push({
            keptId: keep.id,
            removedIds: remove.map(r => r.id)
        });
    }

    return result;
}

/**
 * Detect potential conflicts/contradictions
 * @param {object} params
 * @param {string} params.projectId
 * @param {string} params.tenantId
 * @param {boolean} params.dryRun - If false, create contradiction links
 * @returns {Promise<{conflicts: Array<{id1: string, id2: string, reason: string}>, linksAdded: number}>}
 */
export async function detectConflicts({ projectId, tenantId, dryRun = true }) {
    const result = { conflicts: [], linksAdded: 0 };

    // Get active state items (most likely to have contradictions)
    const states = await query(
        `SELECT id, title, content, created_at
     FROM memory_items
     WHERE tenant_id = ? AND project_id = ? AND type = 'state' AND status = 'active'
     ORDER BY created_at DESC`,
        [tenantId, projectId]
    );

    // Simple contradiction detection: same title but different content
    const byTitle = new Map();

    for (const state of states) {
        const normalizedTitle = normalizeText(state.title);

        if (byTitle.has(normalizedTitle)) {
            const existing = byTitle.get(normalizedTitle);

            // Check if content is different
            const existingHash = contentHash(existing.content);
            const currentHash = contentHash(state.content);

            if (existingHash !== currentHash) {
                result.conflicts.push({
                    id1: existing.id,
                    id2: state.id,
                    reason: `Same title "${state.title}" with different content`
                });

                if (!dryRun) {
                    // Create contradiction link
                    try {
                        await query(
                            `INSERT INTO memory_links (id, from_id, to_id, relation, created_at)
               VALUES (?, ?, ?, 'contradicts', ?)
               ON CONFLICT DO NOTHING`,
                            [uuidv4(), existing.id, state.id, now()]
                        );
                        result.linksAdded++;
                    } catch (err) {
                        logger.warn('Failed to create contradiction link', { error: err.message });
                    }
                }
            }
        } else {
            byTitle.set(normalizedTitle, state);
        }
    }

    // Also check decisions with conflicting conclusions (rudimentary)
    const decisions = await query(
        `SELECT id, title, content, created_at
     FROM memory_items
     WHERE tenant_id = ? AND project_id = ? AND type = 'decision' AND status = 'active'
     ORDER BY created_at DESC`,
        [tenantId, projectId]
    );

    // Group by similar titles
    const decisionByTopic = new Map();

    for (const decision of decisions) {
        const keywords = extractKeywords(decision.title).slice(0, 3).join(' ');

        if (decisionByTopic.has(keywords)) {
            const existing = decisionByTopic.get(keywords);

            // Simple heuristic: if content contains opposing keywords
            const opposites = [
                ['yes', 'no'], ['enable', 'disable'], ['allow', 'deny'],
                ['true', 'false'], ['accept', 'reject'], ['use', 'avoid']
            ];

            const existingLower = existing.content.toLowerCase();
            const currentLower = decision.content.toLowerCase();

            for (const [word1, word2] of opposites) {
                if ((existingLower.includes(word1) && currentLower.includes(word2)) ||
                    (existingLower.includes(word2) && currentLower.includes(word1))) {
                    result.conflicts.push({
                        id1: existing.id,
                        id2: decision.id,
                        reason: `Potentially conflicting decisions about "${keywords}"`
                    });
                    break;
                }
            }
        } else {
            decisionByTopic.set(keywords, decision);
        }
    }

    return result;
}

export default { deduplicateItems, detectConflicts };
