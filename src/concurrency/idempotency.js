/**
 * Idempotency utilities
 * @module concurrency/idempotency
 */
import { query, queryOne } from '../db/index.js';
import { contentHash } from '../utils/hash.js';
import logger from '../utils/logger.js';

/**
 * Check if memory item already exists (for idempotency)
 * @param {object} item - Memory item
 * @returns {Promise<{exists: boolean, existingId?: string, existingVersion?: number}>}
 */
export async function checkIdempotency(item) {
    const hash = item.content_hash || contentHash(item.content);

    const existing = await queryOne(
        `SELECT id, version FROM memory_items 
     WHERE tenant_id = ? AND project_id = ? AND type = ? AND content_hash = ?
     AND status != 'deleted'`,
        [
            item.tenant_id || 'local-user',
            item.project_id || 'default',
            item.type || 'fact',
            hash
        ]
    );

    if (existing) {
        return {
            exists: true,
            existingId: existing.id,
            existingVersion: existing.version
        };
    }

    return { exists: false };
}

/**
 * Generate idempotency key for deduplication
 * @param {string} toolName 
 * @param {object} params 
 * @returns {string}
 */
export function generateIdempotencyKey(toolName, params) {
    const normalized = JSON.stringify(params, Object.keys(params).sort());
    return `${toolName}:${contentHash(normalized)}`;
}

/**
 * Check if operation was already performed (request deduplication)
 * @param {string} idempotencyKey 
 * @param {number} windowMs - Time window for dedup check
 * @returns {Promise<{duplicate: boolean, previousResult?: any}>}
 */
export async function checkRequestIdempotency(idempotencyKey, windowMs = 60000) {
    // Check audit log for recent identical requests
    const windowStart = new Date(Date.now() - windowMs).toISOString();

    const existing = await queryOne(
        `SELECT response_json FROM audit_log 
     WHERE trace_id LIKE ? AND ts > ?
     ORDER BY ts DESC LIMIT 1`,
        [`%${idempotencyKey}%`, windowStart]
    );

    if (existing && existing.response_json) {
        try {
            return {
                duplicate: true,
                previousResult: JSON.parse(existing.response_json)
            };
        } catch {
            // Invalid JSON, treat as no duplicate
        }
    }

    return { duplicate: false };
}

export default { checkIdempotency, generateIdempotencyKey, checkRequestIdempotency };
