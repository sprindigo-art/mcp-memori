/**
 * Database migration script
 * @module db/migrate
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { initDb, getDb, getDbType, closeDb } from './index.js';
import logger from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Split SQL into statements, handling triggers properly
 * @param {string} sql 
 * @returns {string[]}
 */
function splitSqlStatements(sql) {
    const statements = [];
    let current = '';
    let inTrigger = false;

    const lines = sql.split('\n');

    for (const line of lines) {
        const trimmed = line.trim();

        // Skip comments
        if (trimmed.startsWith('--')) continue;

        // Detect trigger start
        if (trimmed.toUpperCase().includes('CREATE TRIGGER')) {
            inTrigger = true;
        }

        current += line + '\n';

        // End of trigger (END;)
        if (inTrigger && trimmed.toUpperCase() === 'END;') {
            statements.push(current.trim());
            current = '';
            inTrigger = false;
            continue;
        }

        // Regular statement end
        if (!inTrigger && trimmed.endsWith(';')) {
            const stmt = current.trim();
            if (stmt.length > 1) { // More than just semicolon
                statements.push(stmt);
            }
            current = '';
        }
    }

    // Handle any remaining
    if (current.trim().length > 0) {
        statements.push(current.trim());
    }

    return statements.filter(s => s.length > 0 && !s.startsWith('--'));
}

/**
 * Run migrations based on database type
 */
async function migrate() {
    logger.info('Starting database migration...');

    try {
        await initDb();
        const dbType = getDbType();
        const db = getDb();

        const schemaFile = dbType === 'postgres'
            ? 'schema.postgres.sql'
            : 'schema.sqlite.sql';

        const schemaPath = join(__dirname, schemaFile);
        const schema = readFileSync(schemaPath, 'utf8');

        if (dbType === 'postgres') {
            await db.query(schema);
        } else {
            // SQLite: execute statements one by one, handling triggers properly
            const statements = splitSqlStatements(schema);

            for (const stmt of statements) {
                try {
                    db.exec(stmt);
                } catch (err) {
                    // Ignore "already exists" errors
                    if (!err.message.includes('already exists') &&
                        !err.message.includes('table memory_items_fts already exists')) {
                        logger.warn('Statement failed:', { stmt: stmt.substring(0, 100), error: err.message });
                    }
                }
            }
        }

        logger.info(`Migration completed successfully (${dbType})`);

        // Verify tables exist
        const tables = await verifyTables(dbType, db);
        logger.info('Tables verified:', { tables });

    } catch (err) {
        logger.error('Migration failed', { error: err.message, stack: err.stack });
        process.exit(1);
    } finally {
        await closeDb();
    }
}

/**
 * Verify required tables exist
 * @param {'postgres'|'sqlite'} dbType 
 * @param {any} db 
 * @returns {Promise<string[]>}
 */
async function verifyTables(dbType, db) {
    const tables = [];
    const required = ['memory_items', 'memory_links', 'audit_log', 'mistakes'];

    for (const table of required) {
        try {
            if (dbType === 'postgres') {
                const result = await db.query(
                    `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)`,
                    [table]
                );
                if (result.rows[0].exists) {
                    tables.push(table);
                }
            } else {
                const result = db.prepare(
                    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
                ).get(table);
                if (result) {
                    tables.push(table);
                }
            }
        } catch (err) {
            logger.warn(`Table check failed for ${table}`, { error: err.message });
        }
    }

    if (tables.length !== required.length) {
        const missing = required.filter(t => !tables.includes(t));
        throw new Error(`Missing tables: ${missing.join(', ')}`);
    }

    return tables;
}

// Run if called directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    migrate().catch(err => {
        console.error(err);
        process.exit(1);
    });
}

export { migrate };
