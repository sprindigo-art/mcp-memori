/**
 * LAYER 4: Intelligence Governance - Guardrails Manager
 * Explicit guardrail management for blocking/suppressing problematic memories
 * @module governance/guardrails
 */
import { query, queryOne } from '../db/index.js';
import { contentHash } from '../utils/hash.js';
import { now, daysAgo } from '../utils/time.js';
import { v4 as uuidv4 } from 'uuid';
import config from '../utils/config.js';
import logger from '../utils/logger.js';

/**
 * Create or update a guardrail
 * @param {object} params
 * @param {string} params.projectId
 * @param {string} params.tenantId
 * @param {string} params.ruleType - 'block' | 'warn' | 'suppress'
 * @param {string} params.pattern - Pattern signature to match
 * @param {string} params.description - Human-readable description
 * @param {string[]} params.suppressIds - IDs to suppress when triggered
 * @param {number} params.expiresInDays - Optional expiration
 * @returns {Promise<{id: string, created: boolean}>}
 */
export async function createGuardrail({
    projectId,
    tenantId,
    ruleType,
    pattern,
    description,
    suppressIds = [],
    expiresInDays = null
}) {
    const signature = contentHash(pattern);

    // Check existing
    const existing = await queryOne(
        `SELECT id FROM guardrails 
         WHERE tenant_id = ? AND project_id = ? AND pattern_signature = ?`,
        [tenantId, projectId, signature]
    );

    const expiresAt = expiresInDays
        ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
        : null;

    if (existing) {
        await query(
            `UPDATE guardrails 
             SET rule_type = ?, description = ?, suppress_ids_json = ?, 
                 active = 1, expires_at = ?
             WHERE id = ?`,
            [ruleType, description, JSON.stringify(suppressIds), expiresAt, existing.id]
        );
        return { id: existing.id, created: false };
    }

    const id = uuidv4();
    await query(
        `INSERT INTO guardrails 
         (id, tenant_id, project_id, rule_type, pattern_signature, description, 
          suppress_ids_json, active, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [id, tenantId, projectId, ruleType, signature, description,
            JSON.stringify(suppressIds), now(), expiresAt]
    );

    logger.info('Guardrail created', { id, ruleType, pattern: signature.slice(0, 8) });
    return { id, created: true };
}

/**
 * Get active guardrails for a project
 * @param {string} projectId
 * @param {string} tenantId
 * @returns {Promise<Array>}
 */
export async function getActiveGuardrails(projectId, tenantId) {
    const currentTime = now();

    return query(
        `SELECT id, rule_type, pattern_signature, description, suppress_ids_json, created_at, expires_at
         FROM guardrails
         WHERE tenant_id = ? AND project_id = ? 
         AND active = 1
         AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY created_at DESC
         LIMIT ?`,
        [tenantId, projectId, currentTime, config.governance.maxGuardrailsPerProject]
    );
}

/**
 * Get all suppressed IDs from active guardrails
 * @param {string} projectId
 * @param {string} tenantId
 * @returns {Promise<{ids: string[], guardrails: Array}>}
 */
export async function getSuppressedIds(projectId, tenantId) {
    const guardrails = await getActiveGuardrails(projectId, tenantId);
    const allSuppressedIds = new Set();

    for (const g of guardrails) {
        try {
            const ids = JSON.parse(g.suppress_ids_json || '[]');
            ids.forEach(id => allSuppressedIds.add(id));
        } catch (e) {
            // Ignore parse errors
        }
    }

    return {
        ids: Array.from(allSuppressedIds),
        guardrails: guardrails.map(g => ({
            id: g.id,
            ruleType: g.rule_type,
            description: g.description,
            suppressCount: JSON.parse(g.suppress_ids_json || '[]').length
        }))
    };
}

/**
 * Deactivate a guardrail
 * @param {string} guardrailId
 * @returns {Promise<boolean>}
 */
export async function deactivateGuardrail(guardrailId) {
    const result = await query(
        `UPDATE guardrails SET active = 0 WHERE id = ?`,
        [guardrailId]
    );
    return result[0]?.changes > 0;
}

/**
 * Check if an item ID is suppressed by any guardrail
 * @param {string} itemId
 * @param {string} projectId
 * @param {string} tenantId
 * @returns {Promise<{suppressed: boolean, reason: string|null}>}
 */
export async function isItemSuppressed(itemId, projectId, tenantId) {
    const { ids, guardrails } = await getSuppressedIds(projectId, tenantId);

    if (ids.includes(itemId)) {
        const reason = guardrails
            .filter(g => {
                try {
                    return JSON.parse(g.suppress_ids_json || '[]').includes(itemId);
                } catch { return false; }
            })
            .map(g => g.description)
            .join('; ');

        return { suppressed: true, reason };
    }

    return { suppressed: false, reason: null };
}

/**
 * Auto-create guardrail from repeated mistake
 * @param {object} params
 * @param {string} params.projectId
 * @param {string} params.tenantId
 * @param {string} params.mistakeSignature
 * @param {number} params.mistakeCount
 * @param {string[]} params.relatedIds
 * @returns {Promise<{guardrailId: string}|null>}
 */
export async function autoGuardrailFromMistake({
    projectId,
    tenantId,
    mistakeSignature,
    mistakeCount,
    relatedIds = []
}) {
    if (mistakeCount < config.governance.loopBreakerThreshold) {
        return null;
    }

    const result = await createGuardrail({
        projectId,
        tenantId,
        ruleType: 'suppress',
        pattern: mistakeSignature,
        description: `Repeated mistake (${mistakeCount}x): Check signature ${mistakeSignature.slice(0, 8)}...`,
        suppressIds: relatedIds,
        expiresInDays: 30 // Auto-expire after 30 days
    });

    logger.info('Auto-guardrail created from mistake', {
        guardrailId: result.id,
        mistakeCount,
        suppressedCount: relatedIds.length
    });

    return { guardrailId: result.id };
}

/**
 * Cleanup expired guardrails
 * @param {string} projectId
 * @param {string} tenantId
 * @returns {Promise<{cleaned: number}>}
 */
export async function cleanupExpiredGuardrails(projectId, tenantId) {
    const currentTime = now();

    const result = await query(
        `UPDATE guardrails SET active = 0 
         WHERE tenant_id = ? AND project_id = ? 
         AND expires_at IS NOT NULL AND expires_at < ?`,
        [tenantId, projectId, currentTime]
    );

    return { cleaned: result[0]?.changes || 0 };
}

/**
 * Get governance state for forensic audit
 * @param {string} projectId
 * @param {string} tenantId
 * @returns {Promise<object>}
 */
export async function getGovernanceState(projectId, tenantId) {
    // Get quarantined items
    const quarantined = await query(
        `SELECT id FROM memory_items 
         WHERE project_id = ? AND tenant_id = ? AND status = 'quarantined'
         LIMIT 10`,
        [projectId, tenantId]
    );

    // Get deleted items (recent)
    const deleted = await query(
        `SELECT id FROM memory_items 
         WHERE project_id = ? AND tenant_id = ? AND status = 'deleted'
         ORDER BY updated_at DESC LIMIT 10`,
        [projectId, tenantId]
    );

    // Get active guardrails
    const guardrails = await getActiveGuardrails(projectId, tenantId);

    // Get suppressed IDs
    const { ids: suppressedIds } = await getSuppressedIds(projectId, tenantId);

    return {
        quarantined_count: quarantined.length,
        quarantined_ids: quarantined.map(r => r.id),
        deleted_count: deleted.length,
        recent_deleted_ids: deleted.map(r => r.id),
        guardrails_active: guardrails.map(g => ({
            id: g.id,
            type: g.rule_type,
            description: g.description
        })),
        suppressed_memory_ids: suppressedIds
    };
}

export default {
    createGuardrail,
    getActiveGuardrails,
    getSuppressedIds,
    deactivateGuardrail,
    isItemSuppressed,
    autoGuardrailFromMistake,
    cleanupExpiredGuardrails,
    getGovernanceState
};
