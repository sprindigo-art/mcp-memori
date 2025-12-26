/**
 * LAYER 5: Cross-Model Intelligence
 * Track and resolve conflicts between different AI models/personas
 * @module governance/crossModel
 */
import { query, queryOne } from '../db/index.js';
import { v4 as uuidv4 } from 'uuid';
import { now } from '../utils/time.js';
import logger from '../utils/logger.js';

/**
 * Record model conflict between two items
 * @param {object} params
 * @param {string} params.projectId
 * @param {string} params.tenantId
 * @param {string} params.itemIdA
 * @param {string} params.itemIdB
 * @param {string} params.conflictType - 'interpretation' | 'contradiction' | 'version'
 * @returns {Promise<{id: string, created: boolean}>}
 */
export async function recordConflict({
    projectId,
    tenantId,
    itemIdA,
    itemIdB,
    conflictType
}) {
    // Normalize order (smaller ID first)
    const [first, second] = [itemIdA, itemIdB].sort();

    // Check existing
    const existing = await queryOne(
        `SELECT id, resolution_status FROM model_conflicts 
         WHERE item_id_a = ? AND item_id_b = ?`,
        [first, second]
    );

    if (existing) {
        return { id: existing.id, created: false, status: existing.resolution_status };
    }

    const id = uuidv4();
    await query(
        `INSERT INTO model_conflicts 
         (id, tenant_id, project_id, item_id_a, item_id_b, conflict_type, 
          resolution_status, detected_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
        [id, tenantId, projectId, first, second, conflictType, now()]
    );

    logger.info('Model conflict recorded', { id, itemIdA: first, itemIdB: second, conflictType });
    return { id, created: true, status: 'pending' };
}

/**
 * Get pending conflicts for a project
 * @param {string} projectId
 * @param {string} tenantId
 * @returns {Promise<Array>}
 */
export async function getPendingConflicts(projectId, tenantId) {
    return query(
        `SELECT mc.*, 
                m1.title as item_a_title, m1.type as item_a_type,
                m1.provenance_json as item_a_provenance,
                m2.title as item_b_title, m2.type as item_b_type,
                m2.provenance_json as item_b_provenance
         FROM model_conflicts mc
         JOIN memory_items m1 ON mc.item_id_a = m1.id
         JOIN memory_items m2 ON mc.item_id_b = m2.id
         WHERE mc.tenant_id = ? AND mc.project_id = ? 
         AND mc.resolution_status = 'pending'
         ORDER BY mc.detected_at DESC`,
        [tenantId, projectId]
    );
}

/**
 * Resolve a conflict
 * @param {string} conflictId
 * @param {string} resolution - 'resolved' | 'ignored'
 * @param {string} notes - Resolution notes
 * @returns {Promise<boolean>}
 */
export async function resolveConflict(conflictId, resolution, notes = '') {
    const result = await query(
        `UPDATE model_conflicts 
         SET resolution_status = ?, resolution_notes = ?, resolved_at = ?
         WHERE id = ?`,
        [resolution, notes, now(), conflictId]
    );

    return result[0]?.changes > 0;
}

/**
 * Extract provenance details from an item
 * @param {object} item
 * @returns {object}
 */
export function parseProvenance(item) {
    let provenance = {};
    try {
        provenance = typeof item.provenance_json === 'string'
            ? JSON.parse(item.provenance_json || '{}')
            : (item.provenance_json || {});
    } catch {
        provenance = {};
    }

    return {
        model_id: provenance.model_id || provenance.model || 'unknown',
        persona: provenance.persona || 'default',
        confidence: provenance.confidence || item.confidence || 0.5,
        session_id: provenance.session_id || null,
        timestamp: provenance.timestamp || item.created_at
    };
}

/**
 * Detect potential conflicts by comparing items from different models
 * @param {string} projectId
 * @param {string} tenantId
 * @returns {Promise<Array<{itemA: object, itemB: object, conflictType: string, confidence: number}>>}
 */
export async function detectPotentialConflicts(projectId, tenantId) {
    // Get active items with provenance
    const items = await query(
        `SELECT id, title, content, type, provenance_json, confidence, created_at
         FROM memory_items
         WHERE project_id = ? AND tenant_id = ? AND status = 'active'
         ORDER BY created_at DESC LIMIT 100`,
        [projectId, tenantId]
    );

    const potentialConflicts = [];
    const processed = new Set();

    for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
            const itemA = items[i];
            const itemB = items[j];
            const pairKey = [itemA.id, itemB.id].sort().join('-');

            if (processed.has(pairKey)) continue;
            processed.add(pairKey);

            const provA = parseProvenance(itemA);
            const provB = parseProvenance(itemB);

            // Only compare items from different models
            if (provA.model_id === provB.model_id) continue;

            // Same type items might have version conflicts
            if (itemA.type === itemB.type && itemA.title === itemB.title) {
                potentialConflicts.push({
                    itemA: { id: itemA.id, title: itemA.title, model: provA.model_id },
                    itemB: { id: itemB.id, title: itemB.title, model: provB.model_id },
                    conflictType: 'version',
                    confidence: 0.8
                });
            }

            // Check for contradictory content (simple keyword overlap heuristic)
            if (itemA.type === itemB.type && hasContradiction(itemA.content, itemB.content)) {
                potentialConflicts.push({
                    itemA: { id: itemA.id, title: itemA.title, model: provA.model_id },
                    itemB: { id: itemB.id, title: itemB.title, model: provB.model_id },
                    conflictType: 'contradiction',
                    confidence: 0.6
                });
            }
        }
    }

    return potentialConflicts;
}

/**
 * Simple contradiction detection (heuristic)
 * @param {string} contentA
 * @param {string} contentB
 * @returns {boolean}
 */
function hasContradiction(contentA, contentB) {
    const negationPairs = [
        ['harus', 'tidak boleh'],
        ['benar', 'salah'],
        ['aktif', 'nonaktif'],
        ['enable', 'disable'],
        ['true', 'false'],
        ['yes', 'no'],
        ['allow', 'deny'],
        ['include', 'exclude']
    ];

    const a = (contentA || '').toLowerCase();
    const b = (contentB || '').toLowerCase();

    for (const [pos, neg] of negationPairs) {
        if ((a.includes(pos) && b.includes(neg)) || (a.includes(neg) && b.includes(pos))) {
            return true;
        }
    }

    return false;
}

/**
 * Get cross-model summary for forensic audit
 * @param {string} projectId
 * @param {string} tenantId
 * @returns {Promise<object>}
 */
export async function getCrossModelSummary(projectId, tenantId) {
    // Get unique models
    const modelItems = await query(
        `SELECT DISTINCT provenance_json FROM memory_items
         WHERE project_id = ? AND tenant_id = ? AND status = 'active'`,
        [projectId, tenantId]
    );

    const uniqueModels = new Set();
    for (const item of modelItems) {
        const prov = parseProvenance(item);
        if (prov.model_id !== 'unknown') {
            uniqueModels.add(prov.model_id);
        }
    }

    // Get pending conflicts count
    const pendingCount = await queryOne(
        `SELECT COUNT(*) as count FROM model_conflicts
         WHERE project_id = ? AND tenant_id = ? AND resolution_status = 'pending'`,
        [projectId, tenantId]
    );

    return {
        models_detected: Array.from(uniqueModels),
        model_count: uniqueModels.size,
        pending_conflicts: pendingCount?.count || 0,
        cross_model_active: uniqueModels.size > 1
    };
}

export default {
    recordConflict,
    getPendingConflicts,
    resolveConflict,
    parseProvenance,
    detectPotentialConflicts,
    getCrossModelSummary
};
