/**
 * Server-side LRU Cache for memory_get optimization
 * Singleton instance shared across all tools
 * Reduces redundant DB I/O (~60% reduction expected)
 * 
 * @module utils/cache
 */
import { LRUCache } from 'lru-cache';
import logger from './logger.js';

/**
 * LRU Cache Configuration
 * - max: 200 items (covers typical session usage)
 * - ttl: 5 minutes (fresh enough for active work, prevents stale data)
 * - updateAgeOnGet: true (frequently used items stay cached)
 */
const cache = new LRUCache({
    max: 200,
    ttl: 5 * 60 * 1000, // 5 minutes in ms
    updateAgeOnGet: true,
    allowStale: false
});

// Stats tracking
let hitCount = 0;
let missCount = 0;

/**
 * Get item from cache by ID
 * @param {string} id - Memory item UUID
 * @returns {object|undefined} Cached item or undefined if miss
 */
export function getFromCache(id) {
    const item = cache.get(id);
    if (item) {
        hitCount++;
        logger.debug('Cache HIT', { id, hits: hitCount, misses: missCount });
    } else {
        missCount++;
    }
    return item;
}

/**
 * Store item in cache
 * @param {string} id - Memory item UUID
 * @param {object} data - Full item data (same structure as DB row)
 */
export function setToCache(id, data) {
    if (id && data) {
        cache.set(id, data);
    }
}

/**
 * Invalidate a specific item from cache
 * Called by: memory_upsert, memory_forget, memory_feedback, memory_maintain
 * @param {string} id - Memory item UUID to invalidate
 */
export function invalidateCache(id) {
    if (id) {
        const had = cache.has(id);
        cache.delete(id);
        if (had) {
            logger.debug('Cache INVALIDATED', { id });
        }
    }
}

/**
 * Invalidate multiple items at once
 * @param {string[]} ids - Array of UUIDs to invalidate
 */
export function invalidateCacheMany(ids) {
    if (Array.isArray(ids)) {
        for (const id of ids) {
            cache.delete(id);
        }
    }
}

/**
 * Clear entire cache (used during maintenance operations)
 */
export function clearCache() {
    cache.clear();
    logger.debug('Cache CLEARED');
}

/**
 * Get cache statistics
 * @returns {object} Cache stats
 */
export function getCacheStats() {
    return {
        size: cache.size,
        maxSize: 200,
        hits: hitCount,
        misses: missCount,
        hitRate: hitCount + missCount > 0
            ? Math.round((hitCount / (hitCount + missCount)) * 100) + '%'
            : 'N/A'
    };
}

export default {
    getFromCache,
    setToCache,
    invalidateCache,
    invalidateCacheMany,
    clearCache,
    getCacheStats
};
