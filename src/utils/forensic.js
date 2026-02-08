/**
 * Forensic & Transparency Utilities - ENHANCED v4.0 COMPACT
 * Compact by default, full forensic on demand
 * @module utils/forensic
 */
import { getDbType } from '../db/index.js';
import { getEmbeddingMode, getEmbeddingBackend, getLastBackend, getLastFallbackReason } from './embedding.js';
import { query } from '../db/index.js';
import config from './config.js';

// Lazy imports to avoid circular dependencies
let guardrailsModule = null;
let crossModelModule = null;

async function getGuardrailsModule() {
    if (!guardrailsModule) {
        guardrailsModule = await import('../governance/guardrails.js');
    }
    return guardrailsModule;
}

async function getCrossModelModule() {
    if (!crossModelModule) {
        crossModelModule = await import('../governance/crossModel.js');
    }
    return crossModelModule;
}

/**
 * Get COMPACT forensic metadata (DEFAULT) - Lightweight for every response
 * Only essential info: backend, mode, governance COUNTS (no UUID arrays)
 * @param {string} tenantId 
 * @param {string} projectId 
 * @returns {Promise<object>}
 */
export async function getForensicMeta(tenantId, projectId) {
    const dbBackend = getDbType();
    const embeddingMode = getEmbeddingMode();
    const backendUsed = getLastBackend();
    const fallbackReason = getLastFallbackReason();

    // Compact governance: only counts, NO UUID arrays
    let quarantinedCount = 0;
    let deletedCount = 0;
    let guardrailsCount = 0;
    try {
        const qRes = await query(
            `SELECT COUNT(*) as cnt FROM memory_items WHERE tenant_id = ? AND project_id = ? AND status = 'quarantined'`,
            [tenantId, projectId]
        );
        quarantinedCount = qRes[0]?.cnt || 0;

        const dRes = await query(
            `SELECT COUNT(*) as cnt FROM memory_items WHERE tenant_id = ? AND project_id = ? AND status = 'deleted'`,
            [tenantId, projectId]
        );
        deletedCount = dRes[0]?.cnt || 0;

        try {
            const gRes = await query(
                `SELECT COUNT(*) as cnt FROM guardrails WHERE tenant_id = ? AND project_id = ? AND active = 1`,
                [tenantId, projectId]
            );
            guardrailsCount = gRes[0]?.cnt || 0;
        } catch { /* guardrails table may not exist */ }
    } catch { /* ignore count errors */ }

    // Cross-model: only count, NO model list
    let modelCount = 0;
    let pendingConflicts = 0;
    try {
        const crossModelMod = await getCrossModelModule();
        const summary = await crossModelMod.getCrossModelSummary(projectId, tenantId);
        modelCount = summary.model_count || 0;
        pendingConflicts = summary.pending_conflicts || 0;
    } catch { /* ignore */ }

    return {
        db_backend: dbBackend,
        embedding_mode: embeddingMode,
        embedding_backend_used: backendUsed || getEmbeddingBackend(),
        embedding_fallback_reason: fallbackReason,
        governance: {
            quarantined: quarantinedCount,
            deleted: deletedCount,
            guardrails_active: guardrailsCount
        },
        cross_model: {
            models: modelCount,
            conflicts: pendingConflicts
        }
    };
}

/**
 * Get FULL forensic metadata - For deep audits and debugging ONLY
 * Includes all UUID arrays, model lists, config details
 * @param {string} tenantId 
 * @param {string} projectId 
 * @returns {Promise<object>}
 */
export async function getFullForensicMeta(tenantId, projectId) {
    const dbBackend = getDbType();
    const embeddingMode = getEmbeddingMode();
    const scoreWeights = config.getScoreWeights();
    const backendUsed = getLastBackend();
    const fallbackReason = getLastFallbackReason();

    const governanceState = await getGovernanceSnapshot(tenantId, projectId);
    const crossModelSummary = await getCrossModelSummary(tenantId, projectId);

    let hybridEffectiveness = 'neutral';
    if (embeddingMode === 'keyword_only' || fallbackReason) {
        hybridEffectiveness = 'low';
    } else if (backendUsed === 'local_sentence_transformer' || backendUsed === 'ollama') {
        hybridEffectiveness = scoreWeights.vector > 0 ? 'high' : 'neutral';
    }

    return {
        db_backend: dbBackend,
        embedding_mode: embeddingMode,
        embedding_backend: getEmbeddingBackend(),
        embedding_backend_used: backendUsed,
        embedding_fallback_reason: fallbackReason,
        hybrid_effectiveness: hybridEffectiveness,
        score_weights: scoreWeights,
        filters_applied: {
            exclude_deleted: true,
            exclude_quarantined: true,
            deprecated_penalty: 0.5
        },
        temporal_config: {
            decay_factors: config.temporalDecay,
            note: 'preferences/rules decay slower than events'
        },
        governance_state: governanceState,
        cross_model: crossModelSummary
    };
}

/**
 * Get governance snapshot - LAYER 4 Enhanced
 */
async function getGovernanceSnapshot(tenantId, projectId) {
    try {
        // Get quarantined IDs
        const quarantined = await query(
            `SELECT id FROM memory_items 
             WHERE tenant_id = ? AND project_id = ? AND status = 'quarantined'
             LIMIT 10`,
            [tenantId, projectId]
        );

        // Get recent deleted IDs
        const deleted = await query(
            `SELECT id FROM memory_items 
             WHERE tenant_id = ? AND project_id = ? 
             AND status = 'deleted' 
             ORDER BY updated_at DESC LIMIT 10`,
            [tenantId, projectId]
        );

        // LAYER 4: Get active guardrails
        let guardrailsActive = [];
        let suppressedIds = [];
        try {
            const guardrailsMod = await getGuardrailsModule();
            const { ids, guardrails } = await guardrailsMod.getSuppressedIds(projectId, tenantId);
            suppressedIds = ids;
            guardrailsActive = guardrails;
        } catch (e) {
            // Guardrails table might not exist yet
        }

        return {
            quarantined_count: quarantined.length,
            quarantined_ids: quarantined.map(i => i.id),
            deleted_count: deleted.length,
            recent_deleted_ids: deleted.map(i => i.id),
            guardrails_active: guardrailsActive,
            suppressed_memory_ids: suppressedIds
        };
    } catch (e) {
        return { error: e.message };
    }
}

/**
 * Get cross-model summary - LAYER 5
 */
async function getCrossModelSummary(tenantId, projectId) {
    try {
        const crossModelMod = await getCrossModelModule();
        return await crossModelMod.getCrossModelSummary(projectId, tenantId);
    } catch (e) {
        // Cross-model table might not exist yet
        return {
            models_detected: [],
            model_count: 0,
            pending_conflicts: 0,
            cross_model_active: false
        };
    }
}

/**
 * Create ultra-minimal forensic meta for very high-frequency operations (upsert, feedback)
 * @param {string} tenantId 
 * @param {string} projectId 
 * @returns {object}
 */
export function getMinimalForensicMeta(tenantId, projectId) {
    return {
        db_backend: getDbType(),
        embedding_mode: getEmbeddingMode()
    };
}

export default { getForensicMeta, getFullForensicMeta, getMinimalForensicMeta };
