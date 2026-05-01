/**
 * Vector Embedding Index v2.0 — Granular per-section semantic search
 * Uses @xenova/transformers (all-MiniLM-L6-v2, 384-dim, local CPU)
 * Stored in search_index.db alongside FTS5 tables
 *
 * v2.0 CHANGE: Each ## section gets its own vector embedding, not just
 * the document header. Enables semantic matching deep inside 900KB runbooks
 * where the old title+450chars approach only covered 0.05% of content.
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
 * Prepare text for embedding: title + tags + body prefix (whole-doc vector)
 */
function prepareEmbeddingText(meta, body) {
    const title = meta.title || '';
    const tags = Array.isArray(meta.tags) ? meta.tags.join(' ') : '';
    const bodyPrefix = (body || '').substring(0, 450);
    return `${title} ${tags} ${bodyPrefix}`.trim();
}

const SKIP_SECTIONS = new Set(['_auto_log', 'session log', '_changelog']);
const MAX_SECTIONS_PER_FILE = 30;

/**
 * Split body into ## sections for granular embedding
 * Returns [{sectionName, text}] — each text = section header context + content prefix
 */
function splitSections(meta, body) {
    const title = meta.title || '';
    const parts = body.split(/(?=^## )/m);
    const sections = [];
    for (const part of parts) {
        const headerMatch = part.match(/^## ([^\n]+)/);
        if (!headerMatch) continue;
        const sectionName = headerMatch[1].trim();
        if (SKIP_SECTIONS.has(sectionName.toLowerCase())) continue;
        const content = part.replace(/^## [^\n]+\n/, '').trim();
        if (content.length < 30) continue;
        const text = `${title} | ${sectionName}: ${content.substring(0, 400)}`;
        sections.push({ sectionName, text: text.substring(0, 500) });
    }
    return sections.slice(0, MAX_SECTIONS_PER_FILE);
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
        db.exec(`
            CREATE TABLE IF NOT EXISTS section_embeddings (
                id TEXT NOT NULL,
                section_name TEXT NOT NULL,
                embedding BLOB,
                embedded_at TEXT,
                PRIMARY KEY (id, section_name)
            )
        `);
        db.exec('CREATE INDEX IF NOT EXISTS idx_sec_emb_id ON section_embeddings(id)');
        logger.info('Vector index tables initialized (v2.0 with section_embeddings)');
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

    let indexed = 0, skipped = 0, failed = 0, sectionsIndexed = 0;
    const now = new Date().toISOString();

    const upsertStmt = db.prepare(`
        INSERT OR REPLACE INTO runbook_embeddings (id, embedding, content_hash, embedded_at, model, dim)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    const upsertSecStmt = db.prepare(`
        INSERT OR REPLACE INTO section_embeddings (id, section_name, embedding, embedded_at)
        VALUES (?, ?, ?, ?)
    `);
    const deleteSecStmt = db.prepare('DELETE FROM section_embeddings WHERE id = ?');

    for (let i = 0; i < files.length; i += 10) {
        const batch = files.slice(i, i + 10);

        for (const file of batch) {
            try {
                const filepath = join(RUNBOOKS_DIR, file);
                const raw = readFileSync(filepath, 'utf8');
                const hash = contentHash(raw);

                if (existing.get(file) === hash) {
                    skipped++;
                    continue;
                }

                const { meta, body } = parseFrontmatter(raw);

                // Whole-doc vector (backward compat)
                const text = prepareEmbeddingText(meta, body);
                const vector = await embed(text);

                if (vector) {
                    const buffer = Buffer.from(vector.buffer || new Float32Array(vector).buffer);
                    upsertStmt.run(file, buffer, hash, now, MODEL_NAME, EMBEDDING_DIM);
                    indexed++;
                } else {
                    failed++;
                }

                // v2.0: Per-section vectors for files >10KB
                if (raw.length > 10000) {
                    deleteSecStmt.run(file);
                    const sections = splitSections(meta, body);
                    for (const sec of sections) {
                        const secVec = await embed(sec.text);
                        if (secVec) {
                            const secBuf = Buffer.from(secVec.buffer || new Float32Array(secVec).buffer);
                            upsertSecStmt.run(file, sec.sectionName, secBuf, now);
                            sectionsIndexed++;
                        }
                    }
                }
            } catch (err) {
                failed++;
                logger.warn('Vector index entry failed', { file, error: err.message });
            }
        }

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
    logger.info('Vector index rebuilt', { indexed, skipped, failed, deleted, sectionsIndexed, total: files.length });
    return { indexed, skipped, failed, deleted, sectionsIndexed };
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
            db.prepare('DELETE FROM section_embeddings WHERE id = ?').run(filename);
            return;
        }

        const raw = readFileSync(filepath, 'utf8');
        const hash = contentHash(raw);

        const existing = db.prepare('SELECT content_hash FROM runbook_embeddings WHERE id = ?').get(filename);
        if (existing && existing.content_hash === hash) return;

        const { meta, body } = parseFrontmatter(raw);
        const now = new Date().toISOString();

        // Whole-doc vector
        const text = prepareEmbeddingText(meta, body);
        const vector = await embed(text);
        if (vector) {
            const buffer = Buffer.from(vector.buffer || new Float32Array(vector).buffer);
            db.prepare(`
                INSERT OR REPLACE INTO runbook_embeddings (id, embedding, content_hash, embedded_at, model, dim)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(filename, buffer, hash, now, MODEL_NAME, EMBEDDING_DIM);
        }

        // v2.0: Per-section vectors for files >10KB
        if (raw.length > 10000) {
            db.prepare('DELETE FROM section_embeddings WHERE id = ?').run(filename);
            const sections = splitSections(meta, body);
            const upsertSec = db.prepare('INSERT OR REPLACE INTO section_embeddings (id, section_name, embedding, embedded_at) VALUES (?, ?, ?, ?)');
            for (const sec of sections) {
                const secVec = await embed(sec.text);
                if (secVec) {
                    const secBuf = Buffer.from(secVec.buffer || new Float32Array(secVec).buffer);
                    upsertSec.run(filename, sec.sectionName, secBuf, now);
                }
            }
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
        db.prepare('DELETE FROM section_embeddings WHERE id = ?').run(filename);
    } catch {}
}

/**
 * Vector similarity search — checks both whole-doc AND per-section vectors.
 * Per-section results are merged by taking the best section similarity per runbook.
 * @param {string} queryText - Search query
 * @param {number} limit - Max results
 * @returns {Promise<Array<{id: string, similarity: number, matched_section?: string}>>}
 */
export async function vectorSearchRunbooks(queryText, limit = 20) {
    if (!db || !vectorReady) return [];

    try {
        const queryVector = await embed(queryText);
        if (!queryVector) return [];

        // Phase 1: whole-doc vectors
        const docRows = db.prepare('SELECT id, embedding FROM runbook_embeddings WHERE embedding IS NOT NULL').all();
        const docScores = new Map();
        for (const row of docRows) {
            try {
                const stored = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.length / 4);
                const sim = cosineSimilarity(queryVector, stored);
                if (sim > 0.15) {
                    docScores.set(row.id, { id: row.id, similarity: sim });
                }
            } catch {}
        }

        // Phase 2: per-section vectors — keep best section per runbook
        try {
            const secRows = db.prepare('SELECT id, section_name, embedding FROM section_embeddings WHERE embedding IS NOT NULL').all();
            for (const row of secRows) {
                try {
                    const stored = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.length / 4);
                    const sim = cosineSimilarity(queryVector, stored);
                    if (sim > 0.2) {
                        const existing = docScores.get(row.id);
                        if (!existing || sim > existing.similarity) {
                            docScores.set(row.id, { id: row.id, similarity: sim, matched_section: row.section_name });
                        }
                    }
                } catch {}
            }
        } catch {}

        const scored = [...docScores.values()];
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
        let secCount = 0;
        try { secCount = db.prepare('SELECT COUNT(*) as cnt FROM section_embeddings').get().cnt; } catch {}
        return { ready: vectorReady, embedded_count: count.cnt, section_count: secCount, model: MODEL_NAME, dim: EMBEDDING_DIM };
    } catch { return { ready: false }; }
}

export default {
    initVectorIndex, rebuildVectorIndex, updateVectorEntry, removeVectorEntry,
    vectorSearchRunbooks, isVectorReady, getVectorStats
};
