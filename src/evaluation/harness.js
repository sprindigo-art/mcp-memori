/**
 * Evaluation harness for retrieval quality
 * @module evaluation/harness
 */
import { hybridSearch } from '../retrieval/hybridSearch.js';
import logger from '../utils/logger.js';

/**
 * Evaluate retrieval quality
 * @param {Array} testCases - Array of {query, expectedIds, projectId}
 * @param {object} options
 * @returns {Promise<object>}
 */
export async function evaluateRetrieval(testCases, options = {}) {
    const { k = 5, tenantId = 'local-user' } = options;

    const results = {
        total: testCases.length,
        passed: 0,
        failed: 0,
        recall_sum: 0,
        precision_sum: 0,
        wrong_memory_count: 0,
        details: []
    };

    for (const testCase of testCases) {
        const { query, expectedIds, projectId } = testCase;

        // Run search
        const { results: searchResults, meta } = await hybridSearch({
            query,
            projectId,
            tenantId,
            limit: k
        });

        const retrievedIds = searchResults.map(r => r.id);

        // Calculate metrics
        const truePositives = expectedIds.filter(id => retrievedIds.includes(id)).length;
        const recall = expectedIds.length > 0 ? truePositives / expectedIds.length : 0;
        const precision = retrievedIds.length > 0 ? truePositives / retrievedIds.length : 0;

        // Check for wrong memories (quarantined/deleted appearing)
        const wrongMemories = searchResults.filter(r =>
            r.status === 'quarantined' || r.status === 'deleted'
        );

        results.recall_sum += recall;
        results.precision_sum += precision;
        results.wrong_memory_count += wrongMemories.length;

        const passed = recall >= 0.5 && wrongMemories.length === 0;
        if (passed) {
            results.passed++;
        } else {
            results.failed++;
        }

        results.details.push({
            query,
            expectedIds,
            retrievedIds,
            recall: Math.round(recall * 100) / 100,
            precision: Math.round(precision * 100) / 100,
            wrongMemories: wrongMemories.length,
            passed,
            mode: meta.mode
        });
    }

    // Calculate averages
    results.recall_at_k = Math.round((results.recall_sum / results.total) * 1000) / 1000;
    results.precision_at_k = Math.round((results.precision_sum / results.total) * 1000) / 1000;
    results.wrong_memory_rate = Math.round((results.wrong_memory_count / results.total) * 1000) / 1000;

    return results;
}

/**
 * Check if evaluation passes regression gate
 * @param {object} evalResult 
 * @param {object} thresholds 
 * @returns {{passed: boolean, reason: string}}
 */
export function checkRegressionGate(evalResult, thresholds = {}) {
    const {
        minRecall = 0.5,
        maxWrongMemoryRate = 0
    } = thresholds;

    if (evalResult.recall_at_k < minRecall) {
        return {
            passed: false,
            reason: `Recall@K ${evalResult.recall_at_k} < threshold ${minRecall}`
        };
    }

    if (evalResult.wrong_memory_rate > maxWrongMemoryRate) {
        return {
            passed: false,
            reason: `Wrong memory rate ${evalResult.wrong_memory_rate} > threshold ${maxWrongMemoryRate}`
        };
    }

    return { passed: true, reason: 'All gates passed' };
}

export default { evaluateRetrieval, checkRegressionGate };
