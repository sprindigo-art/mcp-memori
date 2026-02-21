/**
 * Policy engine for memory governance
 * @module governance/policyEngine
 */
import logger from '../utils/logger.js';

/**
 * Protected tags - items with these tags are immune from auto-quarantine/delete
 * These represent critical operational data that should NEVER be auto-removed
 */
export const PROTECTED_TAGS = [
    'critical',
    'operational',
    'persistence',
    'credential',
    'infrastructure',
    'verified',
    'guardrail',
    'c2',
    'shell',
    'backdoor',
    // Added v2.0 - more protection
    'access',
    'exploit',
    'root',
    'tunnel',
    'ssh',
    'webshell',
    'technique',
    'magic',
    'trigger'
];

/**
 * Default governance policy - LESS AGGRESSIVE v2.0
 */
export const DEFAULT_POLICY = {
    max_age_days: 180,           // Increased from 90
    min_usefulness: -5.0,        // Lowered from -2.0 to allow more variance
    max_error_count: 5,          // Increased from 3
    keep_last_n_episodes: 500,    // Increased from 50 to protect operational history
    quarantine_on_wrong_threshold: 3,  // Increased from 1
    delete_on_wrong_threshold: 5       // Increased from 3
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
 * Check if item is protected from auto-quarantine
 * @param {object} item - Memory item with tags, verified, confidence
 * @returns {boolean}
 */
export function isProtectedItem(item) {
    // Parse tags if string
    let itemTags;
    try {
        itemTags = typeof item.tags === 'string'
            ? JSON.parse(item.tags || '[]')
            : (item.tags || []);
    } catch {
        itemTags = [];
    }

    // Check if any protected tag exists
    const hasProtectedTag = itemTags.some(tag =>
        PROTECTED_TAGS.includes(tag.toLowerCase())
    );

    // Check if verified or high confidence
    const isVerified = item.verified === true || item.verified === 1;
    const isHighConfidence = (item.confidence || 0) >= 0.8;

    // Check if item has been frequently used (high usefulness = valuable)
    const isHighUsefulness = (item.usefulness_score || 0) >= 1.0;

    return hasProtectedTag || isVerified || isHighConfidence || isHighUsefulness;
}

/**
 * Evaluate item against policy
 * @param {object} item - Memory item
 * @param {object} policy - Governance policy
 * @returns {{action: string|null, reason: string|null}}
 */
export function evaluateItem(item, policy) {
    // CRITICAL: Skip protected items from any negative action
    if (isProtectedItem(item)) {
        logger.debug('Skipping protected item', {
            id: item.id,
            verified: item.verified,
            confidence: item.confidence
        });
        return { action: null, reason: null };
    }
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

    // Check usefulness - ONLY quarantine items with NEGATIVE scores (actively downvoted)
    // Score 0 means "no feedback yet", NOT "useless" - these must be PROTECTED
    const hasNegativeFeedback = item.usefulness_score < 0;
    const belowThreshold = item.usefulness_score < policy.min_usefulness;

    if (hasNegativeFeedback && belowThreshold) {
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
    PROTECTED_TAGS,
    DEFAULT_POLICY,
    mergePolicy,
    isProtectedItem,
    evaluateItem,
    getSafeAction,
    isActionSafe
};
