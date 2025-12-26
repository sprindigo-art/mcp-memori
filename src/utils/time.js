/**
 * Time utilities
 * @module utils/time
 */

/**
 * Get current ISO timestamp
 * @returns {string}
 */
export function now() {
    return new Date().toISOString();
}

/**
 * Get timestamp N days ago
 * @param {number} days 
 * @returns {string}
 */
export function daysAgo(days) {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString();
}

/**
 * Calculate recency score with time decay - LAYER 3 Enhanced
 * Uses formula: 1 / (1 + days * decay_factor)
 * Decay factor varies by temporal_type:
 *   - event: 0.15 (fast decay)
 *   - state: 0.1 (normal)
 *   - rule: 0.03 (slow - rules persist)
 *   - preference: 0.02 (slowest - preferences almost permanent)
 * Clamped between 0.05 (minimum) and 1.0 (maximum)
 * @param {string|Date} timestamp 
 * @param {string} temporalType - event|state|rule|preference
 * @returns {number} score between 0.05 and 1.0
 */
export function recencyScore(timestamp, temporalType = 'state') {
    if (!timestamp) return 0.5; // Default fallback for missing timestamp

    const ts = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;

    // Validate timestamp
    if (isNaN(ts.getTime())) return 0.5;

    const ageMs = Date.now() - ts.getTime();
    const ageDays = Math.max(0, ageMs / (1000 * 60 * 60 * 24));

    // LAYER 3: Different decay factors per temporal type
    const decayFactors = {
        event: 0.15,      // Fast decay - events become old quickly
        state: 0.1,       // Normal decay
        rule: 0.03,       // Very slow - rules persist
        preference: 0.02  // Slowest - preferences almost permanent
    };

    const decayFactor = decayFactors[temporalType] || decayFactors.state;

    // Formula: 1 / (1 + days * decay_factor)
    // Examples for 'state' (0.1): 1.0 for today, ~0.91 for 1 day, ~0.5 for 10 days
    // Examples for 'preference' (0.02): 1.0 for today, ~0.98 for 1 day, ~0.83 for 10 days
    const rawScore = 1 / (1 + ageDays * decayFactor);

    // Clamp between 0.05 and 1.0
    return Math.max(0.05, Math.min(1.0, rawScore));
}

/**
 * Parse date string safely
 * @param {string} dateStr 
 * @returns {Date|null}
 */
export function parseDate(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? null : d;
}

export default { now, daysAgo, recencyScore, parseDate };
