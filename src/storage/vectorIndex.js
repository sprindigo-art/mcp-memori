/**
 * Vector Embedding Index v1.0 — Semantic search for .md runbook files
 * Uses @xenova/transformers (all-MiniLM-L6-v2, 384-dim, local CPU)
 * Stored in search_index.db alongside FTS5 tables
 *
 * ADDITIVE LAYER: Does NOT replace FTS5 — runs in parallel, merged via RRF
 * @module storage/vectorIndex
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { RUNBOOKS_DIR, parseFrontmatter, filenameToTitle } from './files.js';
import logger from '../utils/logger.js';

let db = null;
let vectorReady = false;
let embeddingPipeline = null;
let pipelineLoading = null;

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_DIM = 384;

/**
 * Lazy-load the embedding pipeline (3-5s first call, cached after)
 */
async function getEmbeddingPipeline() {
    if (embeddingPipeline) return embeddingPipeline;
    if (pipelineLoading) return pipelineLoading;

    pipelineLoading = (async () => {
        try {
            const { pipeline } = await import('@xenova/transformers');
            embeddingPipeline = await pipeline('feature-extraction', MODEL_NAME, { quantized: true });
            logger.info('Vector embedding model loaded', { model: MODEL_NAME, dim: EMBEDDING_DIM });
            return embeddingPipeline;
        } catch (err) {
            logger.warn('Vector embedding model failed to load (non-fatal)', { error: err.message });
            return null;
        }
    })();

    return pipelineLoading;
}

/**
 * Generate embedding for text
 * @param {string} text - Input text (truncated to ~400 chars internally)
 * @returns {Promise<Float32Array|null>}
 */
async function embed(text) {
    const pipe = await getEmbeddingPipeline();
    if (!pipe) return null;

    try {
        const truncated = text.substring(0, 500);
        const output = await pipe(truncated, { pooling: 'mean', normalize: true });
        return output.data;
    } catch (err) {
        logger.warn('Embedding generation failed', { error: err.message });
        return null;
    }
}

/**
 * Cosine similarity between two vectors
 */
function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}

/**
 * Content hash for change detection
 */
function contentHash(text) {
    return createHash('md5').update(text).digest('hex');
}

/**
 * Prepare text for embedding: title + tags + body prefix
 */
function prepareEmbeddingText(meta, body) {
    const title = meta.title || '';
    const tags = Array.isArray(meta.tags) ? meta.tags.join(' ') : '';
    const bodyPrefix = (body || '').substring(0, 450);
    return `${title} ${tags} ${bodyPrefix}`.trim();
}

/**
 * Initialize vector index tables in search_index.db
 * @param {object} database - better-sqlite3 db instance from searchIndex
 */
export function initVectorIndex(database) {
    db = database;
    if (!db) return false;

    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS runbook_embeddings (
                id TEXT PRIMARY KEY,
                embedding BLOB,
                content_hash TEXT,
                embedded_at TEXT,
                model TEXT DEFAULT '${MODEL_NAME}',
                dim INTEGER DEFAULT ${EMBEDDING_DIM}
            )
        `);
        logger.info('Vector index tables initialized');
        return true;
    } catch (err) {
        logger.warn('Vector index init failed (non-fatal)', { error: err.message });
        return false;
    }
}

/**
 * Rebuild vector index for ALL .md files (background, async)
 * Skips files whose content_hash hasn't changed
 */
export async function rebuildVectorIndex() {
    if (!db) return { indexed: 0, skipped: 0 };

    const files = readdirSync(RUNBOOKS_DIR).filter(f => f.endsWith('.md'));
    const existing = new Map();

    try {
        const rows = db.prepare('SELECT id, content_hash FROM runbook_embeddings').all();
        for (const row of rows) existing.set(row.id, row.content_hash);
    } catch {}

    let indexed = 0, skipped = 0, failed = 0;
    const now = new Date().toISOString();

    const upsertStmt = db.prepare(`
        INSERT OR REPLACE INTO runbook_embeddings (id, embedding, content_hash, embedded_at, model, dim)
        VALUES (?, ?, ?, ?, ?, ?)
    `);

    // Process in batches of 10 to avoid blocking
    for (let i = 0; i < files.length; i += 10) {
        const batch = files.slice(i, i + 10);

        for (const file of batch) {
            try {
                const filepath = join(RUNBOOKS_DIR, file);
                const raw = readFileSync(filepath, 'utf8');
                const hash = contentHash(raw);

                // Skip if unchanged
                if (existing.get(file) === hash) {
                    skipped++;
                    continue;
                }

                const { meta, body } = parseFrontmatter(raw);
                const text = prepareEmbeddingText(meta, body);
                const vector = await embed(text);

                if (vector) {
                    const buffer = Buffer.from(vector.buffer || new Float32Array(vector).buffer);
                    upsertStmt.run(file, buffer, hash, now, MODEL_NAME, EMBEDDING_DIM);
                    indexed++;
                } else {
                    failed++;
                }
            } catch (err) {
                failed++;
                logger.warn('Vector index entry failed', { file, error: err.message });
            }
        }

        // Yield to event loop between batches
        await new Promise(resolve => setTimeout(resolve, 1));
    }

    // Remove entries for deleted files
    const currentFiles = new Set(files);
    let deleted = 0;
    const deleteStmt = db.prepare('DELETE FROM runbook_embeddings WHERE id = ?');
    for (const [id] of existing) {
        if (!currentFiles.has(id)) {
            deleteStmt.run(id);
            deleted++;
        }
    }

    vectorReady = indexed > 0 || skipped > 0;
    logger.info('Vector index rebuilt', { indexed, skipped, failed, deleted, total: files.length });
    return { indexed, skipped, failed, deleted };
}

/**
 * Update single vector entry (called after upsert)
 */
export async function updateVectorEntry(filename) {
    if (!db) return;

    try {
        const filepath = join(RUNBOOKS_DIR, filename);
        if (!existsSync(filepath)) {
            db.prepare('DELETE FROM runbook_embeddings WHERE id = ?').run(filename);
            return;
        }

        const raw = readFileSync(filepath, 'utf8');
        const hash = contentHash(raw);

        // Skip if unchanged
        const existing = db.prepare('SELECT content_hash FROM runbook_embeddings WHERE id = ?').get(filename);
        if (existing && existing.content_hash === hash) return;

        const { meta, body } = parseFrontmatter(raw);
        const text = prepareEmbeddingText(meta, body);
        const vector = await embed(text);

        if (vector) {
            const buffer = Buffer.from(vector.buffer || new Float32Array(vector).buffer);
            db.prepare(`
                INSERT OR REPLACE INTO runbook_embeddings (id, embedding, content_hash, embedded_at, model, dim)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(filename, buffer, hash, new Date().toISOString(), MODEL_NAME, EMBEDDING_DIM);
        }
    } catch (err) {
        logger.warn('Vector entry update failed (non-fatal)', { filename, error: err.message });
    }
}

/**
 * Remove vector entry
 */
export function removeVectorEntry(filename) {
    if (!db) return;
    try {
        db.prepare('DELETE FROM runbook_embeddings WHERE id = ?').run(filename);
    } catch {}
}

/**
 * Vector similarity search against all embedded runbooks
 * @param {string} queryText - Search query
 * @param {number} limit - Max results
 * @returns {Promise<Array<{id: string, similarity: number}>>}
 */
export async function vectorSearchRunbooks(queryText, limit = 20) {
    if (!db || !vectorReady) return [];

    try {
        const queryVector = await embed(queryText);
        if (!queryVector) return [];

        const rows = db.prepare('SELECT id, embedding FROM runbook_embeddings WHERE embedding IS NOT NULL').all();

        const scored = [];
        for (const row of rows) {
            try {
                const stored = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.length / 4);
                const sim = cosineSimilarity(queryVector, stored);
                if (sim > 0.15) { // Min threshold to reduce noise
                    scored.push({ id: row.id, similarity: sim });
                }
            } catch {}
        }

        scored.sort((a, b) => b.similarity - a.similarity);
        return scored.slice(0, limit);
    } catch (err) {
        logger.warn('Vector search failed (non-fatal)', { error: err.message });
        return [];
    }
}

/**
 * Check if vector search is ready
 */
export function isVectorReady() {
    return vectorReady && db !== null;
}

/**
 * Get vector index stats
 */
export function getVectorStats() {
    if (!db) return { ready: false };
    try {
        const count = db.prepare('SELECT COUNT(*) as cnt FROM runbook_embeddings').get();
        return { ready: vectorReady, embedded_count: count.cnt, model: MODEL_NAME, dim: EMBEDDING_DIM };
    } catch { return { ready: false }; }
}

export default {
    initVectorIndex, rebuildVectorIndex, updateVectorEntry, removeVectorEntry,
    vectorSearchRunbooks, isVectorReady, getVectorStats
};
