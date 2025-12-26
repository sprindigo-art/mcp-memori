/**
 * Local Sentence Transformer Embeddings v3.0
 * Uses @xenova/transformers (CPU, no external API)
 * @module utils/embedding-local
 */
import logger from './logger.js';

let pipeline = null;
let extractor = null;
let modelLoaded = false;
let loadingPromise = null;

// Model: all-MiniLM-L6-v2 (22MB, fast, good quality)
const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';

/**
 * Initialize the sentence transformer (lazy load)
 * @returns {Promise<boolean>}
 */
async function initializeModel() {
    if (modelLoaded) return true;
    if (loadingPromise) return loadingPromise;

    loadingPromise = (async () => {
        try {
            logger.info('Loading sentence transformer model...', { model: MODEL_NAME });

            // Dynamic import to avoid loading at startup
            const { pipeline: createPipeline } = await import('@xenova/transformers');

            // Create feature extraction pipeline
            extractor = await createPipeline('feature-extraction', MODEL_NAME, {
                quantized: true // Use quantized model for speed
            });

            modelLoaded = true;
            logger.info('Sentence transformer loaded successfully');
            return true;
        } catch (err) {
            logger.error('Failed to load sentence transformer', { error: err.message });
            modelLoaded = false;
            return false;
        }
    })();

    return loadingPromise;
}

/**
 * Generate embedding using local sentence transformer
 * @param {string} text 
 * @param {number} timeoutMs 
 * @returns {Promise<{embedding: number[]|null, fallbackReason: string|null, backend: string}>}
 */
export async function generateLocalEmbedding(text, timeoutMs = 30000) {
    const backend = 'local_sentence_transformer';

    try {
        // Initialize model if not loaded
        const ready = await Promise.race([
            initializeModel(),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Model load timeout')), timeoutMs)
            )
        ]);

        if (!ready || !extractor) {
            return {
                embedding: null,
                fallbackReason: 'model_not_available',
                backend
            };
        }

        // Generate embedding
        const output = await extractor(text.slice(0, 512), {
            pooling: 'mean',
            normalize: true
        });

        // Convert to array
        const embedding = Array.from(output.data);

        return { embedding, fallbackReason: null, backend };
    } catch (err) {
        logger.warn('Local embedding failed', { error: err.message });
        return {
            embedding: null,
            fallbackReason: `local_error: ${err.message}`,
            backend
        };
    }
}

/**
 * Check if local embedding is available
 * @returns {Promise<boolean>}
 */
export async function isLocalEmbeddingAvailable() {
    if (modelLoaded) return true;

    try {
        return await initializeModel();
    } catch {
        return false;
    }
}

/**
 * Get model info
 * @returns {object}
 */
export function getModelInfo() {
    return {
        name: MODEL_NAME,
        loaded: modelLoaded,
        dimensions: 384, // MiniLM-L6 output dimension
        quantized: true
    };
}

export default {
    generateLocalEmbedding,
    isLocalEmbeddingAvailable,
    getModelInfo
};
