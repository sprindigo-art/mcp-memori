/**
 * FTS5 Search Index v7.1 — SQLite index for .md runbook files
 * PRIMARY STORAGE: .md files (unchanged)
 * THIS MODULE: Search index only — speeds up search from O(n files) to O(log n)
 *
 * Sync strategy:
 * - On startup: build index from all .md files
 * - On upsert/delete: update single index entry
 * - On search: use FTS5 BM25 ranking
 *
 * @module storage/searchIndex
 */
import Database from 'better-sqlite3';
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { RUNBOOKS_DIR, parseFrontmatter, filenameToTitle } from './files.js';
import logger from '../utils/logger.js';

const INDEX_DB_PATH = '/home/kali/Desktop/mcp-memori/data/search_index.db';

let db = null;
let indexReady = false;

/**
 * Initialize the FTS5 search index database
 */
export function initSearchIndex() {
    try {
        // Ensure data dir exists
        const dataDir = '/home/kali/Desktop/mcp-memori/data';
        if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

        db = new Database(INDEX_DB_PATH);
        db.pragma('journal_mode = WAL');
        db.pragma('busy_timeout = 5000');
        db.pragma('synchronous = NORMAL');

        // Create FTS5 virtual table for fast text search
        db.exec(`
            CREATE TABLE IF NOT EXISTS runbook_index (
                id TEXT PRIMARY KEY,
                title TEXT,
                tags TEXT,
                content TEXT,
                updated_at TEXT,
                file_size INTEGER DEFAULT 0,
                access_count INTEGER DEFAULT 0,
                success INTEGER DEFAULT 0,
                verified INTEGER DEFAULT 0,
                indexed_at TEXT
            )
        `);

        db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS runbook_fts USING fts5(
                id UNINDEXED,
                title,
                tags,
                content,
                tokenize='porter unicode61'
            )
        `);

        // Triggers to keep FTS in sync with runbook_index
        db.exec(`
            CREATE TRIGGER IF NOT EXISTS runbook_ai AFTER INSERT ON runbook_index BEGIN
                INSERT INTO runbook_fts(id, title, tags, content)
                VALUES (new.id, new.title, new.tags, new.content);
            END
        `);

        db.exec(`
            CREATE TRIGGER IF NOT EXISTS runbook_ad AFTER DELETE ON runbook_index BEGIN
                DELETE FROM runbook_fts WHERE id = old.id;
            END
        `);

        db.exec(`
            CREATE TRIGGER IF NOT EXISTS runbook_au AFTER UPDATE ON runbook_index BEGIN
                DELETE FROM runbook_fts WHERE id = old.id;
                INSERT INTO runbook_fts(id, title, tags, content)
                VALUES (new.id, new.title, new.tags, new.content);
            END
        `);

        logger.info('Search index DB initialized', { path: INDEX_DB_PATH });

        // Build/rebuild index from .md files
        rebuildIndex();

        indexReady = true;
        return true;
    } catch (err) {
        logger.error('Search index init failed', { error: err.message });
        indexReady = false;
        return false;
    }
}

/**
 * Rebuild entire index from .md files
 * Only re-indexes files that changed since last index
 */
function rebuildIndex() {
    if (!db) return;

    const files = readdirSync(RUNBOOKS_DIR).filter(f => f.endsWith('.md'));
    const now = new Date().toISOString();

    // Get existing index entries for comparison
    const existing = new Map();
    try {
        const rows = db.prepare('SELECT id, updated_at, file_size FROM runbook_index').all();
        for (const row of rows) {
            existing.set(row.id, { updated_at: row.updated_at, file_size: row.file_size });
        }
    } catch {}

    const upsertStmt = db.prepare(`
        INSERT OR REPLACE INTO runbook_index (id, title, tags, content, updated_at, file_size, access_count, success, verified, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, COALESCE((SELECT access_count FROM runbook_index WHERE id = ?), 0), ?, ?, ?)
    `);

    let indexed = 0;
    let skipped = 0;

    const transaction = db.transaction(() => {
        for (const file of files) {
            const filepath = join(RUNBOOKS_DIR, file);
            let stat;
            try { stat = statSync(filepath); } catch { continue; }

            // Skip if file hasn't changed (same size + same updated_at in frontmatter)
            const ex = existing.get(file);

            let raw;
            try { raw = readFileSync(filepath, 'utf8'); } catch { continue; }
            const { meta, body } = parseFrontmatter(raw);

            const fileUpdated = meta.updated || stat.mtime.toISOString();

            // Skip if already indexed and file hasn't changed
            if (ex && ex.updated_at === fileUpdated && ex.file_size === stat.size) {
                skipped++;
                existing.delete(file);
                continue;
            }

            const title = meta.title || filenameToTitle(file);
            const tags = Array.isArray(meta.tags) ? meta.tags.join(' ') : (meta.tags || '');
            // Index first 200K chars of content (50K was too small — credential/persistence at bottom of large runbooks was unsearchable)
            const contentForIndex = body.substring(0, 200000);

            upsertStmt.run(
                file, title, tags, contentForIndex,
                fileUpdated, stat.size,
                file, // for COALESCE access_count
                meta.success === true ? 1 : 0,
                meta.verified === true ? 1 : 0,
                now
            );

            indexed++;
            existing.delete(file);
        }

        // Remove index entries for deleted files
        const deleteStmt = db.prepare('DELETE FROM runbook_index WHERE id = ?');
        for (const [deletedId] of existing) {
            deleteStmt.run(deletedId);
        }
    });

    transaction();

    logger.info('Search index rebuilt', {
        indexed,
        skipped,
        deleted: existing.size,
        total: files.length
    });
}

/**
 * Update single entry in index (called after upsert)
 */
export function updateIndexEntry(filename) {
    if (!db || !indexReady) return;

    try {
        const filepath = join(RUNBOOKS_DIR, filename);
        if (!existsSync(filepath)) {
            // File deleted, remove from index
            db.prepare('DELETE FROM runbook_index WHERE id = ?').run(filename);
            return;
        }

        const raw = readFileSync(filepath, 'utf8');
        const { meta, body } = parseFrontmatter(raw);
        const stat = statSync(filepath);
        const title = meta.title || filenameToTitle(filename);
        const tags = Array.isArray(meta.tags) ? meta.tags.join(' ') : (meta.tags || '');
        const contentForIndex = body.substring(0, 200000);
        const now = new Date().toISOString();

        db.prepare(`
            INSERT OR REPLACE INTO runbook_index (id, title, tags, content, updated_at, file_size, access_count, success, verified, indexed_at)
            VALUES (?, ?, ?, ?, ?, ?, COALESCE((SELECT access_count FROM runbook_index WHERE id = ?), 0), ?, ?, ?)
        `).run(
            filename, title, tags, contentForIndex,
            meta.updated || now, stat.size,
            filename,
            meta.success === true ? 1 : 0,
            meta.verified === true ? 1 : 0,
            now
        );
    } catch (err) {
        logger.warn('Index entry update failed', { filename, error: err.message });
    }
}

/**
 * Remove entry from index (called after delete)
 */
export function removeIndexEntry(filename) {
    if (!db || !indexReady) return;
    try {
        db.prepare('DELETE FROM runbook_index WHERE id = ?').run(filename);
    } catch (err) {
        logger.warn('Index entry remove failed', { filename, error: err.message });
    }
}

/**
 * Increment access count for usefulness scoring
 */
export function incrementAccessCount(filename) {
    if (!db || !indexReady) return;
    try {
        db.prepare('UPDATE runbook_index SET access_count = access_count + 1 WHERE id = ?').run(filename);
    } catch {}
}

/**
 * Get access count for a runbook
 */
export function getAccessCount(filename) {
    if (!db || !indexReady) return 0;
    try {
        const row = db.prepare('SELECT access_count FROM runbook_index WHERE id = ?').get(filename);
        return row ? row.access_count : 0;
    } catch { return 0; }
}

/**
 * FTS5 Search — fast search using BM25 ranking
 * @param {string} queryStr - Search query
 * @param {object} options - Search options
 * @returns {Array<{id, title, score, snippet}>} Ranked results
 */
export function ftsSearch(queryStr, options = {}) {
    if (!db || !indexReady) return null; // Fallback signal

    const { limit = 50 } = options;
    const words = (queryStr || '').toLowerCase().split(/\s+/).filter(w => w.length >= 2);
    if (words.length === 0) return null;

    try {
        // Build FTS5 query: OR for 1-2 words, AND for 3+
        // With prefix matching (*) for partial word support
        const useAnd = words.length >= 3;
        const ftsTokens = words.slice(0, 8).map(w => `"${w}"*`);
        const ftsQuery = useAnd ? ftsTokens.join(' AND ') : ftsTokens.join(' OR ');

        const rows = db.prepare(`
            SELECT ri.id, ri.title, ri.tags, ri.updated_at, ri.file_size,
                   ri.access_count, ri.success, ri.verified,
                   bm25(runbook_fts, 0, 5.0, 3.0, 1.0) as bm25_score
            FROM runbook_fts fts
            JOIN runbook_index ri ON fts.id = ri.id
            WHERE runbook_fts MATCH ?
            ORDER BY bm25_score
            LIMIT ?
        `).all(ftsQuery, limit);

        // If AND returned too few, fallback to OR
        if (useAnd && rows.length < 3) {
            const orQuery = ftsTokens.join(' OR ');
            const orRows = db.prepare(`
                SELECT ri.id, ri.title, ri.tags, ri.updated_at, ri.file_size,
                       ri.access_count, ri.success, ri.verified,
                       bm25(runbook_fts, 0, 5.0, 3.0, 1.0) as bm25_score
                FROM runbook_fts fts
                JOIN runbook_index ri ON fts.id = ri.id
                WHERE runbook_fts MATCH ?
                ORDER BY bm25_score
                LIMIT ?
            `).all(orQuery, limit);
            return orRows.map(r => ({
                ...r,
                bm25_score: Math.abs(r.bm25_score),
                tags: r.tags ? r.tags.split(' ') : []
            }));
        }

        return rows.map(r => ({
            ...r,
            bm25_score: Math.abs(r.bm25_score), // BM25 returns negative in SQLite
            tags: r.tags ? r.tags.split(' ') : []
        }));
    } catch (err) {
        logger.warn('FTS search failed, will fallback to file scan', { error: err.message });
        return null; // Signal to fallback
    }
}

/**
 * Check if index is ready
 */
export function isIndexReady() {
    return indexReady && db !== null;
}

/**
 * Get index stats
 */
export function getIndexStats() {
    if (!db || !indexReady) return { ready: false };
    try {
        const count = db.prepare('SELECT COUNT(*) as cnt FROM runbook_index').get();
        const totalAccess = db.prepare('SELECT SUM(access_count) as total FROM runbook_index').get();
        return {
            ready: true,
            indexed_count: count.cnt,
            total_access: totalAccess.total || 0,
            db_path: INDEX_DB_PATH
        };
    } catch { return { ready: false }; }
}

export default {
    initSearchIndex,
    updateIndexEntry,
    removeIndexEntry,
    incrementAccessCount,
    getAccessCount,
    ftsSearch,
    isIndexReady,
    getIndexStats
};
