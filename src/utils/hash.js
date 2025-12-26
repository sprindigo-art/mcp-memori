/**
 * Content hashing untuk idempotency
 * @module utils/hash
 */
import { createHash } from 'crypto';

/**
 * Generate SHA-256 hash dari content
 * @param {string} content 
 * @returns {string} hex hash
 */
export function contentHash(content) {
    return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Generate hash untuk idempotency (tenant + project + type + content)
 * @param {object} item 
 * @returns {string}
 */
export function idempotencyHash(item) {
    const normalized = [
        item.tenant_id || 'local-user',
        item.project_id || 'default',
        item.type || 'fact',
        normalizeContent(item.content || '')
    ].join('::');
    return contentHash(normalized);
}

/**
 * Normalize content untuk hashing konsisten
 * @param {string} content 
 * @returns {string}
 */
export function normalizeContent(content) {
    return content
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

export default { contentHash, idempotencyHash, normalizeContent };
