/**
 * Policy engine for memory governance
 * @module governance/policyEngine
 */
import logger from '../utils/logger.js';

/**
 * Default governance policy
 */
export const DEFAULT_POLICY = {
    max_age_days: 90,
    min_usefulness: -2.0,
    max_error_count: 3,
    keep_last_n_episodes: 10,
    quarantine_on_wrong_threshold: 1,
    delete_on_wrong_threshold: 3
};

/**
 * Merge user policy with defaults
 * @param {object} userPolicy 
 * @returns {object}
 */
export function mergePolicy(userPolicy = {}) {
    return {
        ...DEFAULT_POLICY,
        ...userPolicy
    };
}

/**
 * Evaluate item against policy
 * @param {object} item - Memory item
 * @param {object} policy - Governance policy
 * @returns {{action: string|null, reason: string|null}}
 */
export function evaluateItem(item, policy) {
    // Check error count
    if (item.error_count >= policy.delete_on_wrong_threshold) {
        // Safe rules: decision/state should not be auto-deleted
        if (item.type === 'decision') {
            return { action: 'deprecated', reason: `Error count ${item.error_count} >= delete threshold` };
        }
        if (item.type === 'state') {
            return { action: 'supersede', reason: `Error count ${item.error_count} >= delete threshold` };
        }
        return { action: 'deleted', reason: `Error count ${item.error_count} >= delete threshold` };
    }

    if (item.error_count >= policy.quarantine_on_wrong_threshold) {
        return { action: 'quarantined', reason: `Error count ${item.error_count} >= quarantine threshold` };
    }

    // Check usefulness
    if (item.usefulness_score < policy.min_usefulness) {
        if (item.type === 'decision' || item.type === 'state') {
            return { action: 'deprecated', reason: `Low usefulness score ${item.usefulness_score}` };
        }
        return { action: 'quarantined', reason: `Low usefulness score ${item.usefulness_score}` };
    }

    // Check age (for episodes)
    if (item.type === 'episode') {
        const ageMs = Date.now() - new Date(item.created_at).getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);

        if (ageDays > policy.max_age_days) {
            return { action: 'compact', reason: `Episode age ${Math.floor(ageDays)} days > ${policy.max_age_days}` };
        }
    }

    return { action: null, reason: null };
}

/**
 * Get safe action based on item type
 * @param {string} type - Item type
 * @param {string} requestedAction - Requested action
 * @returns {string}
 */
export function getSafeAction(type, requestedAction) {
    // Safe rules: certain types cannot be directly deleted
    if (requestedAction === 'deleted') {
        if (type === 'decision') return 'deprecated';
        if (type === 'state') return 'supersede';
    }
    return requestedAction;
}

/**
 * Check if action is safe for item type
 * @param {string} type 
 * @param {string} action 
 * @returns {boolean}
 */
export function isActionSafe(type, action) {
    if (action === 'deleted') {
        return !['decision', 'state'].includes(type);
    }
    return true;
}

export default {
    DEFAULT_POLICY,
    mergePolicy,
    evaluateItem,
    getSafeAction,
    isActionSafe
};
