/**
 * Hybrid search v3.2 - Keyword + Vector + Recency with Local Sentence Transformer
 * LAYER 1: Configurable hybrid scoring (keyword 0.5, vector 0.3, recency 0.2)
 * LAYER 3: Temporal-aware recency with type-based decay
 * @module retrieval/hybridSearch
 */
import { keywordSearch } from './keyword.js';
import { vectorSearch } from './vector.js';
import { recencyScore } from '../utils/time.js';
import { getEmbeddingMode, shouldUseVector, clearFallbackReason } from '../utils/embedding.js';
import config from '../utils/config.js';
import logger from '../utils/logger.js';

/**
 * Hybrid search with configurable weights and automatic fallback
 * @param {object} params
 * @param {string} params.query - Search query
 * @param {string} params.projectId
 * @param {string} params.tenantId
 * @param {string[]} params.types - Filter by types
 * @param {string[]} params.tags - Filter by tags
 * @param {boolean} params.overrideQuarantine - Include quarantined items
 * @param {number} params.limit
 * @returns {Promise<{results: Array, meta: object}>}
 */
export async function hybridSearch(params) {
    const {
        query: searchQuery,
        projectId = 'default',
        tenantId = 'local-user',
        types = [],
        tags = [],
        overrideQuarantine = false,
        limit = 10
    } = params;

    const excludeStatus = overrideQuarantine
        ? ['deleted']
        : ['deleted', 'quarantined'];

    const requestedMode = getEmbeddingMode();
    const requestedWeights = config.getScoreWeights();

    // Clear previous fallback state
    clearFallbackReason();

    // Track fallback for forensic audit
    let fallbackReason = null;
    let vectorFailed = false;
    let vectorCount = 0;

    // Run keyword search (ALWAYS runs - deterministic baseline)
    const keywordResults = await keywordSearch({
        query: searchQuery,
        projectId,
        tenantId,
        types,
        tags,
        excludeStatus,
        limit: limit * 2
    });

    // Run vector search if mode requires it
    let vectorResults = [];
    if (shouldUseVector()) {
        try {
            const vectorResponse = await vectorSearch({
                query: searchQuery,
                projectId,
                tenantId,
                types,
                tags,
                excludeStatus,
                limit: limit * 2
            });

            if (vectorResponse.fallbackReason) {
                vectorFailed = true;
                fallbackReason = vectorResponse.fallbackReason;
            } else {
                vectorResults = vectorResponse.results || [];
                vectorCount = vectorResults.length;
            }
        } catch (err) {
            vectorFailed = true;
            fallbackReason = `vector_exception: ${err.message}`;
            logger.warn('Vector search exception', { error: err.message });
        }
    }

    // Determine effective mode and weights
    const effectiveMode = vectorFailed ? 'keyword_only' : requestedMode;
    const effectiveWeights = vectorFailed
        ? config.scoreWeights.keyword_only
        : requestedWeights;

    // Merge and score results
    const merged = mergeResults(keywordResults, vectorResults);

    // Apply ranking with temporal intelligence (LAYER 3)
    const ranked = rankResults(merged, effectiveWeights);

    // Take top results
    const topResults = ranked.slice(0, limit);

    return {
        results: topResults,
        meta: {
            mode: effectiveMode,
            requestedMode,
            weights: effectiveWeights,
            fallbackReason,
            keywordCount: keywordResults.length,
            vectorCount,
            mergedCount: merged.length,
            vectorEnabled: shouldUseVector(),
            vectorSucceeded: !vectorFailed && vectorCount > 0
        }
    };
}

/**
 * Merge keyword and vector results
 */
function mergeResults(keywordResults, vectorResults) {
    const merged = new Map();

    // Add keyword results
    for (const item of keywordResults) {
        merged.set(item.id, {
            ...item,
            keyword_score: item.score || 0,
            vector_score: 0
        });
    }

    // Merge vector results
    if (vectorResults && vectorResults.length > 0) {
        for (const item of vectorResults) {
            if (merged.has(item.id)) {
                merged.get(item.id).vector_score = item.score || 0;
            } else {
                merged.set(item.id, {
                    ...item,
                    keyword_score: 0,
                    vector_score: item.score || 0
                });
            }
        }
    }

    return Array.from(merged.values());
}

/**
 * Rank results with LAYER 1 weights and LAYER 3 temporal intelligence
 * @param {Array} results 
 * @param {object} weights - {keyword, vector, recency}
 * @returns {Array}
 */
function rankResults(results, weights) {
    const scored = results.map(item => {
        // LAYER 3: Calculate recency with temporal type awareness
        const timestamp = item.updated_at || item.created_at;
        const temporalType = mapToTemporalType(item.type, item.tags);
        const recency = recencyScore(timestamp, temporalType);

        // Verified bonus
        const verifiedBonus = item.verified ? 0.1 : 0;

        // Deprecated penalty
        const deprecatedPenalty = item.status === 'deprecated' ? 0.7 : 1.0;

        // Normalize keyword score (BM25 can be > 1)
        const normalizedKeyword = Math.min(1.0, (item.keyword_score || 0) / 20);

        // LAYER 1: Apply configurable weights
        let finalScore = (
            weights.keyword * normalizedKeyword +
            weights.vector * (item.vector_score || 0) +
            weights.recency * recency +
            verifiedBonus
        ) * deprecatedPenalty;

        // Cap at 1.0
        finalScore = Math.min(1.0, finalScore);

        return {
            ...item,
            final_score: finalScore,
            score_breakdown: {
                keyword: item.keyword_score || 0,
                keyword_normalized: normalizedKeyword,
                vector: item.vector_score || 0,
                recency,
                verified_bonus: verifiedBonus,
                temporal_type: temporalType
            }
        };
    });

    // Sort by final score
    scored.sort((a, b) => b.final_score - a.final_score);

    return scored;
}

/**
 * LAYER 3: Map memory type + tags to temporal type for decay calculation
 */
function mapToTemporalType(type, tags) {
    const tagArray = typeof tags === 'string' ? JSON.parse(tags || '[]') : (tags || []);

    // Check tags first for explicit temporal hints
    if (tagArray.includes('user_preference') || tagArray.includes('preference')) {
        return 'preference';
    }
    if (tagArray.includes('rule') || tagArray.includes('policy') || tagArray.includes('guardrail')) {
        return 'rule';
    }
    if (tagArray.includes('event') || tagArray.includes('log') || tagArray.includes('episode')) {
        return 'event';
    }

    // Fallback to type-based mapping
    switch (type) {
        case 'episode':
            return 'event';
        case 'decision':
        case 'runbook':
            return 'rule';
        case 'fact':
        case 'state':
        default:
            return 'state';
    }
}

export default { hybridSearch };
