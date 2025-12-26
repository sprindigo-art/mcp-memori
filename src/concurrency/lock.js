/**
 * Distributed lock implementation
 * @module concurrency/lock
 */
import { withLock as dbWithLock, getDbType } from '../db/index.js';
import logger from '../utils/logger.js';

/** @type {Map<string, Promise<any>>} */
const inMemoryLocks = new Map();

/**
 * Acquire lock and execute callback
 * @param {string} key - Lock key (usually project_id)
 * @param {Function} callback - Function to execute while holding lock
 * @param {number} timeoutMs - Lock timeout in milliseconds
 * @returns {Promise<any>}
 */
export async function withLock(key, callback, timeoutMs = 30000) {
    const lockKey = `mcp-memori:${key}`;

    // For SQLite, use in-memory lock to avoid deadlocks
    if (getDbType() === 'sqlite') {
        return withInMemoryLock(lockKey, callback, timeoutMs);
    }

    // For Postgres, use advisory lock
    return dbWithLock(lockKey, callback);
}

/**
 * In-memory lock for SQLite
 * @param {string} key 
 * @param {Function} callback 
 * @param {number} timeoutMs 
 * @returns {Promise<any>}
 */
async function withInMemoryLock(key, callback, timeoutMs) {
    const startTime = Date.now();

    // Wait for existing lock
    while (inMemoryLocks.has(key)) {
        if (Date.now() - startTime > timeoutMs) {
            throw new Error(`Lock timeout: ${key}`);
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }

    // Acquire lock
    let lockPromise;
    const executor = async () => {
        try {
            return await callback();
        } finally {
            inMemoryLocks.delete(key);
        }
    };

    lockPromise = executor();
    inMemoryLocks.set(key, lockPromise);

    return lockPromise;
}

/**
 * Check if lock is currently held
 * @param {string} key 
 * @returns {boolean}
 */
export function isLocked(key) {
    return inMemoryLocks.has(`mcp-memori:${key}`);
}

export default { withLock, isLocked };
