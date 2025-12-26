/**
 * Database abstraction layer dengan auto-detection Postgres/SQLite
 * @module db/index
 */
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import config from '../utils/config.js';
import logger from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {'postgres'|'sqlite'} */
let dbType = 'sqlite';
/** @type {import('pg').Pool|import('better-sqlite3').Database|null} */
let db = null;

/**
 * Initialize database connection
 * @returns {Promise<void>}
 */
export async function initDb() {
    // Try Postgres first
    if (config.postgresUrl) {
        try {
            const pg = await import('pg');
            const pool = new pg.default.Pool({ connectionString: config.postgresUrl });
            await pool.query('SELECT 1');
            db = pool;
            dbType = 'postgres';
            logger.info('Connected to PostgreSQL');
            return;
        } catch (err) {
            logger.warn('PostgreSQL connection failed, falling back to SQLite', { error: err.message });
        }
    }

    // Fallback to SQLite
    try {
        const sqlite = await import('better-sqlite3');
        const dbPath = config.sqlitePath.startsWith('.')
            ? join(dirname(fileURLToPath(import.meta.url)), '../../', config.sqlitePath)
            : config.sqlitePath;

        // Ensure directory exists
        const dbDir = dirname(dbPath);
        if (!existsSync(dbDir)) {
            mkdirSync(dbDir, { recursive: true });
        }

        db = new sqlite.default(dbPath);
        db.pragma('journal_mode = WAL');
        db.pragma('busy_timeout = 30000');
        db.pragma('synchronous = NORMAL');
        dbType = 'sqlite';
        logger.info('Connected to SQLite', { path: dbPath });
    } catch (err) {
        logger.error('SQLite connection failed', { error: err.message });
        throw err;
    }
}

/**
 * Get database type
 * @returns {'postgres'|'sqlite'}
 */
export function getDbType() {
    return dbType;
}

/**
 * Get raw database connection
 * @returns {import('pg').Pool|import('better-sqlite3').Database}
 */
export function getDb() {
    if (!db) throw new Error('Database not initialized. Call initDb() first.');
    return db;
}

/**
 * Execute a query
 * @param {string} sql - SQL query
 * @param {any[]} params - Query parameters
 * @returns {Promise<any[]>}
 */
export async function query(sql, params = []) {
    if (!db) throw new Error('Database not initialized');

    if (dbType === 'postgres') {
        // Convert ? placeholders to $1, $2, etc for Postgres
        let idx = 0;
        const pgSql = sql.replace(/\?/g, () => `$${++idx}`);
        const result = await db.query(pgSql, params);
        return result.rows;
    } else {
        // SQLite
        const stmt = db.prepare(sql);
        if (sql.trim().toUpperCase().startsWith('SELECT') ||
            sql.trim().toUpperCase().startsWith('WITH')) {
            return stmt.all(...params);
        } else {
            const result = stmt.run(...params);
            return [{ changes: result.changes, lastInsertRowid: result.lastInsertRowid }];
        }
    }
}

/**
 * Execute a query and return single row
 * @param {string} sql 
 * @param {any[]} params 
 * @returns {Promise<any|null>}
 */
export async function queryOne(sql, params = []) {
    const rows = await query(sql, params);
    return rows[0] || null;
}

/**
 * Execute multiple statements in transaction
 * @param {Function} callback - Receives transaction context
 * @returns {Promise<any>}
 */
export async function transaction(callback) {
    if (!db) throw new Error('Database not initialized');

    if (dbType === 'postgres') {
        const client = await db.connect();
        try {
            await client.query('BEGIN');
            const result = await callback({
                query: async (sql, params = []) => {
                    let idx = 0;
                    const pgSql = sql.replace(/\?/g, () => `$${++idx}`);
                    const res = await client.query(pgSql, params);
                    return res.rows;
                },
                queryOne: async (sql, params = []) => {
                    let idx = 0;
                    const pgSql = sql.replace(/\?/g, () => `$${++idx}`);
                    const res = await client.query(pgSql, params);
                    return res.rows[0] || null;
                }
            });
            await client.query('COMMIT');
            return result;
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } else {
        // SQLite transaction
        const trx = db.transaction((cb) => {
            return cb({
                query: (sql, params = []) => {
                    const stmt = db.prepare(sql);
                    if (sql.trim().toUpperCase().startsWith('SELECT') ||
                        sql.trim().toUpperCase().startsWith('WITH')) {
                        return stmt.all(...params);
                    } else {
                        const result = stmt.run(...params);
                        return [{ changes: result.changes, lastInsertRowid: result.lastInsertRowid }];
                    }
                },
                queryOne: (sql, params = []) => {
                    const stmt = db.prepare(sql);
                    return stmt.get(...params) || null;
                }
            });
        });
        return trx(callback);
    }
}

/**
 * Close database connection
 * @returns {Promise<void>}
 */
export async function closeDb() {
    if (!db) return;

    if (dbType === 'postgres') {
        await db.end();
    } else {
        db.close();
    }
    db = null;
    logger.info('Database connection closed');
}

/**
 * Advisory lock for Postgres, mutex for SQLite
 * @param {string} lockKey 
 * @param {Function} callback 
 * @returns {Promise<any>}
 */
export async function withLock(lockKey, callback) {
    if (dbType === 'postgres') {
        // Use PostgreSQL advisory lock
        const lockId = hashCode(lockKey);
        const client = await db.connect();
        try {
            await client.query('SELECT pg_advisory_lock($1)', [lockId]);
            const result = await callback();
            await client.query('SELECT pg_advisory_unlock($1)', [lockId]);
            return result;
        } finally {
            client.release();
        }
    } else {
        // SQLite: use exclusive transaction
        return transaction(callback);
    }
}

/**
 * Simple hash code for lock key
 * @param {string} str 
 * @returns {number}
 */
function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
}

export default {
    initDb,
    getDb,
    getDbType,
    query,
    queryOne,
    transaction,
    closeDb,
    withLock
};
