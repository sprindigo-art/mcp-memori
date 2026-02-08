/**
 * Result reranking and post-processing
 * @module retrieval/rerank
 */
import { extractKeywords } from '../utils/normalize.js';
import logger from '../utils/logger.js';

/**
 * Rerank results based on additional signals
 * @param {Array} results - Search results
 * @param {string} query - Original query
 * @param {object} options - Reranking options
 * @returns {Array}
 */
export function rerank(results, query, options = {}) {
    const {
        boostVerified = true,
        boostRecent = true,
        penalizeErrors = true,
        maxResults = 10
    } = options;

    const keywords = extractKeywords(query);

    const reranked = results.map(result => {
        let score = result.score || 0;

        // Boost verified items
        if (boostVerified && result.verified) {
            score *= 1.15;
        }

        // Penalize items with errors
        if (penalizeErrors && result.error_count > 0) {
            score *= Math.max(0.5, 1 - (result.error_count * 0.1));
        }

        // Boost based on usefulness signal (v3.0: amplified for success/fail differentiation)
        if (result.usefulness_score > 0) {
            score *= (1 + Math.min(0.5, result.usefulness_score * 0.2));
        } else if (result.usefulness_score < 0) {
            score *= Math.max(0.6, 1 + result.usefulness_score * 0.1);
        }

        // Title match bonus
        if (keywords.length > 0) {
            const titleLower = (result.title || '').toLowerCase();
            const titleMatches = keywords.filter(k => titleLower.includes(k)).length;
            if (titleMatches > 0) {
                score *= (1 + (titleMatches / keywords.length) * 0.1);
            }
        }

        // Confidence factor
        const confidenceBoost = 1 + ((result.confidence || 0.5) - 0.5) * 0.2;
        score *= confidenceBoost;

        return {
            ...result,
            score // Natural score for better ranking differentiation
        };
    });

    // Sort by final score
    reranked.sort((a, b) => b.score - a.score);

    return reranked.slice(0, maxResults);
}

/**
 * Diversify results to avoid redundancy
 * @param {Array} results 
 * @param {number} maxPerType - Max results per type
 * @returns {Array}
 */
export function diversify(results, maxPerType = 3) {
    const byType = new Map();
    const diversified = [];

    for (const result of results) {
        const type = result.type || 'fact';
        const count = byType.get(type) || 0;

        if (count < maxPerType) {
            diversified.push(result);
            byType.set(type, count + 1);
        }
    }

    return diversified;
}

export default { rerank, diversify };
