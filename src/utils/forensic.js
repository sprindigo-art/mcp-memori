/**
 * Forensic & Transparency Utilities - ENHANCED v3.0
 * All 5 LAYERS integrated for complete audit trail
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
 * Get standard forensic metadata - ENHANCED with all 5 LAYERS
 * @param {string} tenantId 
 * @param {string} projectId 
 * @returns {Promise<object>}
 */
export async function getForensicMeta(tenantId, projectId) {
    const dbBackend = getDbType();
    const embeddingMode = getEmbeddingMode();
    const scoreWeights = config.getScoreWeights();
    const backendUsed = getLastBackend();
    const fallbackReason = getLastFallbackReason();

    // Get current governance snapshot (LAYER 4 enhanced)
    const governanceState = await getGovernanceSnapshot(tenantId, projectId);

    // Get cross-model summary (LAYER 5)
    const crossModelSummary = await getCrossModelSummary(tenantId, projectId);

    // Determine hybrid effectiveness (FIX #3)
    let hybridEffectiveness = 'neutral';
    if (embeddingMode === 'keyword_only' || fallbackReason) {
        hybridEffectiveness = 'low';
    } else if (backendUsed === 'local_sentence_transformer' || backendUsed === 'ollama') {
        hybridEffectiveness = scoreWeights.vector > 0 ? 'high' : 'neutral';
    }

    return {
        db_backend: dbBackend,

        // LAYER 1: Embedding mode with current weights
        embedding_mode: embeddingMode,
        embedding_backend: getEmbeddingBackend(),
        embedding_backend_used: backendUsed,
        embedding_fallback_reason: fallbackReason,
        hybrid_effectiveness: hybridEffectiveness,
        score_weights: scoreWeights,

        // Standard filters
        filters_applied: {
            exclude_deleted: true,
            exclude_quarantined: true,
            deprecated_penalty: 0.5
        },

        // LAYER 3: Temporal config
        temporal_config: {
            decay_factors: config.temporalDecay,
            note: 'preferences/rules decay slower than events'
        },

        // LAYER 4: Governance state with guardrails
        governance_state: governanceState,

        // LAYER 5: Cross-model intelligence
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
 * Create compact forensic meta for high-frequency operations
 * @param {string} tenantId 
 * @param {string} projectId 
 * @returns {Promise<object>}
 */
export async function getCompactForensicMeta(tenantId, projectId) {
    const dbBackend = getDbType();
    const embeddingMode = getEmbeddingMode();

    return {
        db_backend: dbBackend,
        embedding_mode: embeddingMode,
        filters_applied: {
            exclude_deleted: true,
            exclude_quarantined: true,
            deprecated_penalty: 0.5
        }
    };
}

export default { getForensicMeta, getCompactForensicMeta };
