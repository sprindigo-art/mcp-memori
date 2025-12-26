/**
 * Embedding utilities v3.0 - Multi-backend support
 * Backends: ollama, local_sentence_transformer, off
 * @module utils/embedding
 */
import config from './config.js';
import logger from './logger.js';
import { generateLocalEmbedding, isLocalEmbeddingAvailable, getModelInfo } from './embedding-local.js';

// Track state for forensic reporting
let lastFallbackReason = null;
let lastBackend = null;
let ollamaAvailable = null;

/**
 * Get configured embedding backend
 * @returns {'ollama'|'local'|'off'}
 */
export function getEmbeddingBackend() {
    return process.env.EMBEDDING_BACKEND || 'local'; // Default to local
}

/**
 * Check if Ollama is reachable
 * @returns {Promise<boolean>}
 */
async function checkOllamaHealth() {
    if (ollamaAvailable !== null) return ollamaAvailable;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        const response = await fetch(`${config.ollamaUrl}/api/tags`, {
            method: 'GET',
            signal: controller.signal
        });

        clearTimeout(timeoutId);
        ollamaAvailable = response.ok;

        // Reset cache after 60 seconds
        setTimeout(() => { ollamaAvailable = null; }, 60000);

        return ollamaAvailable;
    } catch {
        ollamaAvailable = false;
        setTimeout(() => { ollamaAvailable = null; }, 30000);
        return false;
    }
}

/**
 * Generate embedding via Ollama
 * @param {string} text 
 * @param {number} timeoutMs 
 * @returns {Promise<{embedding: number[]|null, fallbackReason: string|null, backend: string}>}
 */
async function generateOllamaEmbedding(text, timeoutMs = 10000) {
    const backend = 'ollama';

    const healthy = await checkOllamaHealth();
    if (!healthy) {
        return { embedding: null, fallbackReason: 'ollama_unavailable', backend };
    }

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(`${config.ollamaUrl}/api/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: config.ollamaModel,
                prompt: text.slice(0, 8192)
            }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            return { embedding: null, fallbackReason: `ollama_error: ${response.status}`, backend };
        }

        const data = await response.json();
        if (!data.embedding?.length) {
            return { embedding: null, fallbackReason: 'ollama_empty_response', backend };
        }

        return { embedding: data.embedding, fallbackReason: null, backend };
    } catch (err) {
        const reason = err.name === 'AbortError'
            ? 'ollama_timeout'
            : `ollama_error: ${err.message}`;
        return { embedding: null, fallbackReason: reason, backend };
    }
}

/**
 * Generate embedding using configured backend with fallback chain
 * Priority: configured backend -> fallback to local -> fallback to null
 * @param {string} text 
 * @param {number} timeoutMs 
 * @returns {Promise<{embedding: number[]|null, fallbackReason: string|null, backend: string}>}
 */
export async function generateEmbedding(text, timeoutMs = 15000) {
    const mode = getEmbeddingMode();
    const requestedBackend = getEmbeddingBackend();

    // Mode off = no embedding
    if (mode === 'keyword_only') {
        lastBackend = 'off';
        lastFallbackReason = 'mode_keyword_only';
        return { embedding: null, fallbackReason: 'mode_keyword_only', backend: 'off' };
    }

    let result;

    // Try requested backend first
    if (requestedBackend === 'ollama') {
        result = await generateOllamaEmbedding(text, timeoutMs);
        if (result.embedding) {
            lastBackend = 'ollama';
            lastFallbackReason = null;
            return result;
        }
        // Fallback to local
        logger.info('Ollama failed, falling back to local embedding');
    }

    // Try local (default or fallback)
    if (requestedBackend === 'local' || !result?.embedding) {
        result = await generateLocalEmbedding(text, timeoutMs);
        if (result.embedding) {
            lastBackend = 'local_sentence_transformer';
            lastFallbackReason = requestedBackend === 'ollama' ? 'ollama_fallback_to_local' : null;
            return {
                ...result,
                fallbackReason: lastFallbackReason
            };
        }
    }

    // All backends failed
    lastBackend = 'off';
    lastFallbackReason = result?.fallbackReason || 'all_backends_failed';
    return {
        embedding: null,
        fallbackReason: lastFallbackReason,
        backend: 'off'
    };
}

/**
 * Calculate cosine similarity between two vectors
 * @param {number[]} a 
 * @param {number[]} b 
 * @returns {number} Similarity score 0-1
 */
export function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;

    // Cosine similarity is already -1 to 1, normalize to 0-1
    return (dotProduct / denominator + 1) / 2;
}

/**
 * Get current embedding mode from config
 * @returns {'keyword_only'|'hybrid'|'vector_only'}
 */
export function getEmbeddingMode() {
    return process.env.EMBEDDING_MODE || config.embeddingMode || 'hybrid'; // Default to hybrid now
}

/**
 * Check if vector search should be attempted
 * @returns {boolean}
 */
export function shouldUseVector() {
    const mode = getEmbeddingMode();
    return (mode === 'hybrid' || mode === 'vector_only');
}

/**
 * Get last fallback reason (for forensic reporting)
 * @returns {string|null}
 */
export function getLastFallbackReason() {
    return lastFallbackReason;
}

/**
 * Get last used backend
 * @returns {string|null}
 */
export function getLastBackend() {
    return lastBackend;
}

/**
 * Clear fallback state (for new request)
 */
export function clearFallbackReason() {
    lastFallbackReason = null;
    lastBackend = null;
}

/**
 * Check if any embedding backend is available
 * @returns {Promise<boolean>}
 */
export async function isEmbeddingAvailable() {
    const mode = getEmbeddingMode();
    if (mode === 'keyword_only') return false;

    const backend = getEmbeddingBackend();
    if (backend === 'ollama') {
        return await checkOllamaHealth();
    }
    if (backend === 'local') {
        return await isLocalEmbeddingAvailable();
    }
    return false;
}

/**
 * Get embedding system info for forensic
 * @returns {Promise<object>}
 */
export async function getEmbeddingInfo() {
    const backend = getEmbeddingBackend();
    const mode = getEmbeddingMode();

    return {
        mode,
        backend,
        local_model: getModelInfo(),
        ollama_available: await checkOllamaHealth().catch(() => false),
        last_fallback_reason: lastFallbackReason,
        last_backend_used: lastBackend
    };
}

export default {
    generateEmbedding,
    cosineSimilarity,
    getEmbeddingMode,
    getEmbeddingBackend,
    shouldUseVector,
    getLastFallbackReason,
    getLastBackend,
    clearFallbackReason,
    isEmbeddingAvailable,
    getEmbeddingInfo
};
