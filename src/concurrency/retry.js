/**
 * Retry utilities with exponential backoff
 * @module concurrency/retry
 */
import logger from '../utils/logger.js';

/**
 * Retry function with exponential backoff
 * @param {Function} fn - Function to retry
 * @param {object} options - Retry options
 * @param {number} options.maxRetries - Maximum retry attempts (default: 5)
 * @param {number} options.baseDelayMs - Base delay in ms (default: 100)
 * @param {number} options.maxDelayMs - Maximum delay in ms (default: 5000)
 * @param {Function} options.shouldRetry - Function to check if should retry (default: always)
 * @returns {Promise<any>}
 */
export async function retry(fn, options = {}) {
    const {
        maxRetries = 5,
        baseDelayMs = 100,
        maxDelayMs = 5000,
        shouldRetry = () => true
    } = options;

    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn(attempt);
        } catch (err) {
            lastError = err;

            // Check if we should retry
            if (attempt >= maxRetries || !shouldRetry(err)) {
                throw err;
            }

            // Calculate delay with exponential backoff + jitter
            const delay = Math.min(
                baseDelayMs * Math.pow(2, attempt) + Math.random() * 100,
                maxDelayMs
            );

            logger.debug(`Retry attempt ${attempt + 1}/${maxRetries}`, {
                error: err.message,
                delayMs: delay
            });

            await sleep(delay);
        }
    }

    throw lastError;
}

/**
 * Check if error is retryable (SQLITE_BUSY, deadlock, etc)
 * @param {Error} err 
 * @returns {boolean}
 */
export function isRetryableError(err) {
    const message = err.message?.toLowerCase() || '';
    return (
        message.includes('sqlite_busy') ||
        message.includes('database is locked') ||
        message.includes('deadlock') ||
        message.includes('serialize') ||
        message.includes('could not serialize') ||
        message.includes('retry')
    );
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms 
 * @returns {Promise<void>}
 */
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export default { retry, isRetryableError, sleep };
