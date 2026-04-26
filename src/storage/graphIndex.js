/**
 * Knowledge Graph Index v1.0 — Lightweight entity-relation index for runbooks
 * Extracts entities from frontmatter tags + title, builds cross-runbook relations
 * Stored in search_index.db alongside FTS5 + vector tables
 *
 * Enables: "all targets using PostgreSQL", "all techniques that failed", cross-runbook reasoning
 * ADDITIVE LAYER: Does NOT replace existing search
 * @module storage/graphIndex
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { RUNBOOKS_DIR, parseFrontmatter, filenameToTitle } from './files.js';
import logger from '../utils/logger.js';

let db = null;

/**
 * Known service names for entity classification
 */
const KNOWN_SERVICES = new Set([
    'postgresql', 'mysql', 'redis', 'mongodb', 'elasticsearch', 'mssql', 'oracle', 'mariadb',
    'nginx', 'apache', 'tomcat', 'iis', 'lighttpd', 'caddy', 'jetty',
    'ssh', 'rdp', 'ftp', 'smb', 'telnet', 'vnc', 'winrm',
    'geoserver', 'zimbra', 'proxmox', 'vcenter', 'nutanix', 'kubernetes', 'docker',
    'cloudflare', 'wordpress', 'laravel', 'django', 'jenkins', 'gitlab', 'grafana',
    'axigen', 'mikrotik', 'unifi', 'wireguard', 'openvpn', 'haproxy',
    'nagios', 'zabbix', 'librenms', 'portainer', 'truenas', 'metabase',
    'solana', 'jupiter', 'phantom', 'dexscreener'
]);

/**
 * Known technique words for entity classification
 */
const KNOWN_TECHNIQUES = new Set([
    'sqli', 'xxe', 'xss', 'ssrf', 'lfi', 'rfi', 'ssti', 'idor', 'csrf',
    'rce', 'privesc', 'bypass', 'injection', 'deserialization', 'webshell',
    'upload', 'file-upload', 'brute', 'spray', 'credential-stuffing',
    'dns-zone-transfer', 'subdomain-takeover', 'jwt', 'api', 'git-dump',
    'reverse-shell', 'tunnel', 'pivot', 'persistence', 'backdoor', 'exfil',
    'kernel-exploit', 'suid', 'capabilities', 'cron', 'docker-escape',
    'maphack', 'mod', 'hooking', 'anti-cheat', 'scalping', 'trading'
]);

/**
 * Classify entity type from tag name
 */
function classifyEntity(tag) {
    const lower = tag.toLowerCase().trim();
    if (!lower || lower.length < 2) return null;

    if (/^cve-\d{4}-\d+$/i.test(lower)) return 'cve';
    if (KNOWN_SERVICES.has(lower)) return 'service';
    if (KNOWN_TECHNIQUES.has(lower)) return 'technique';
    if (/^\d{4}-\d{2}/.test(lower)) return 'date'; // Skip date tags
    if (/^(proven|legacy|test|universal|registry)/.test(lower)) return 'meta';

    return 'tag';
}

/**
 * Extract target name from runbook title
 */
function extractTarget(title) {
    const match = (title || '').match(/^\[RUNBOOK\]\s*(.+)/i);
    if (match) return { name: match[1].trim().toLowerCase(), type: 'target' };
    const teknikMatch = (title || '').match(/^\[TEKNIK\]\s*(.+)/i);
    if (teknikMatch) return { name: teknikMatch[1].trim().toLowerCase(), type: 'technique_name' };
    return null;
}

/**
 * Initialize knowledge graph tables in search_index.db
 * @param {object} database - better-sqlite3 db instance
 */
export function initGraphIndex(database) {
    db = database;
    if (!db) return false;

    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS kg_entities (
                name TEXT PRIMARY KEY,
                type TEXT,
                count INTEGER DEFAULT 1
            )
        `);

        db.exec(`
            CREATE TABLE IF NOT EXISTS kg_links (
                runbook_id TEXT,
                entity_name TEXT,
                relation TEXT DEFAULT 'tagged',
                PRIMARY KEY (runbook_id, entity_name, relation)
            )
        `);

        db.exec('CREATE INDEX IF NOT EXISTS idx_kg_links_entity ON kg_links(entity_name)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_kg_links_runbook ON kg_links(runbook_id)');

        logger.info('Knowledge graph tables initialized');
        return true;
    } catch (err) {
        logger.warn('Knowledge graph init failed (non-fatal)', { error: err.message });
        return false;
    }
}

/**
 * Rebuild entire knowledge graph from all .md files
 */
export function rebuildGraphIndex() {
    if (!db) return { entities: 0, links: 0 };

    const files = readdirSync(RUNBOOKS_DIR).filter(f => f.endsWith('.md'));

    // Clear and rebuild (fast — no embeddings needed)
    const transaction = db.transaction(() => {
        db.exec('DELETE FROM kg_entities');
        db.exec('DELETE FROM kg_links');

        const entityCounts = new Map();
        const insertLink = db.prepare('INSERT OR IGNORE INTO kg_links (runbook_id, entity_name, relation) VALUES (?, ?, ?)');
        let totalLinks = 0;

        for (const file of files) {
            try {
                const filepath = join(RUNBOOKS_DIR, file);
                const raw = readFileSync(filepath, 'utf8');
                const { meta } = parseFrontmatter(raw);

                // Extract target from title
                const target = extractTarget(meta.title || filenameToTitle(file));
                if (target) {
                    insertLink.run(file, target.name, target.type === 'target' ? 'targets' : 'implements');
                    entityCounts.set(target.name, (entityCounts.get(target.name) || 0) + 1);
                    totalLinks++;
                }

                // Extract entities from tags
                const tags = Array.isArray(meta.tags) ? meta.tags : [];
                for (const tag of tags) {
                    const entityType = classifyEntity(tag);
                    if (!entityType || entityType === 'date' || entityType === 'meta') continue;

                    const entityName = tag.toLowerCase().trim();
                    const relation = entityType === 'service' ? 'uses_service'
                        : entityType === 'cve' ? 'exploits_cve'
                        : entityType === 'technique' ? 'uses_technique'
                        : 'tagged';

                    insertLink.run(file, entityName, relation);
                    entityCounts.set(entityName, (entityCounts.get(entityName) || 0) + 1);
                    totalLinks++;
                }
            } catch {}
        }

        // Insert entities with counts
        const insertEntity = db.prepare('INSERT OR REPLACE INTO kg_entities (name, type, count) VALUES (?, ?, ?)');
        for (const [name, count] of entityCounts) {
            const type = classifyEntity(name) || 'tag';
            insertEntity.run(name, type, count);
        }

        return { entities: entityCounts.size, links: totalLinks };
    });

    const result = transaction();
    logger.info('Knowledge graph rebuilt', result);
    return result;
}

/**
 * Update graph entries for single runbook (on upsert)
 */
export function updateGraphEntry(filename) {
    if (!db) return;

    try {
        // Remove old links for this file
        db.prepare('DELETE FROM kg_links WHERE runbook_id = ?').run(filename);

        const filepath = join(RUNBOOKS_DIR, filename);
        if (!existsSync(filepath)) return;

        const raw = readFileSync(filepath, 'utf8');
        const { meta } = parseFrontmatter(raw);

        const insertLink = db.prepare('INSERT OR IGNORE INTO kg_links (runbook_id, entity_name, relation) VALUES (?, ?, ?)');

        // Target from title
        const target = extractTarget(meta.title || filenameToTitle(filename));
        if (target) {
            insertLink.run(filename, target.name, target.type === 'target' ? 'targets' : 'implements');
        }

        // Entities from tags
        const tags = Array.isArray(meta.tags) ? meta.tags : [];
        for (const tag of tags) {
            const entityType = classifyEntity(tag);
            if (!entityType || entityType === 'date' || entityType === 'meta') continue;

            const entityName = tag.toLowerCase().trim();
            const relation = entityType === 'service' ? 'uses_service'
                : entityType === 'cve' ? 'exploits_cve'
                : entityType === 'technique' ? 'uses_technique'
                : 'tagged';
            insertLink.run(filename, entityName, relation);
        }

        // Recount all entities
        db.exec(`
            INSERT OR REPLACE INTO kg_entities (name, type, count)
            SELECT entity_name, 'tag', COUNT(*) FROM kg_links GROUP BY entity_name
        `);
    } catch (err) {
        logger.warn('Graph entry update failed (non-fatal)', { filename, error: err.message });
    }
}

/**
 * Remove graph entries for deleted runbook
 */
export function removeGraphEntry(filename) {
    if (!db) return;
    try {
        db.prepare('DELETE FROM kg_links WHERE runbook_id = ?').run(filename);
    } catch {}
}

/**
 * Query: find all runbooks linked to an entity
 * @param {string} entityName - Entity to search for
 * @returns {Array<{runbook_id, relation, title}>}
 */
export function queryGraph(entityName) {
    if (!db) return [];
    try {
        const lower = entityName.toLowerCase().trim();
        return db.prepare(`
            SELECT kl.runbook_id, kl.relation, ri.title, ri.success, ri.verified
            FROM kg_links kl
            LEFT JOIN runbook_index ri ON kl.runbook_id = ri.id
            WHERE kl.entity_name = ? OR kl.entity_name LIKE ?
            ORDER BY ri.updated_at DESC
        `).all(lower, `%${lower}%`);
    } catch { return []; }
}

/**
 * Find entities that co-occur with given entity (2-hop reasoning)
 * entity → runbooks → other entities in those runbooks
 * @param {string} entityName
 * @param {number} limit
 * @returns {Array<{name, type, count, shared_runbooks}>}
 */
export function findRelatedEntities(entityName, limit = 20) {
    if (!db) return [];
    try {
        const lower = entityName.toLowerCase().trim();
        return db.prepare(`
            SELECT kl2.entity_name as name, ke.type, COUNT(DISTINCT kl2.runbook_id) as shared_runbooks
            FROM kg_links kl1
            JOIN kg_links kl2 ON kl1.runbook_id = kl2.runbook_id
            LEFT JOIN kg_entities ke ON kl2.entity_name = ke.name
            WHERE kl1.entity_name = ?
            AND kl2.entity_name != ?
            GROUP BY kl2.entity_name
            ORDER BY shared_runbooks DESC
            LIMIT ?
        `).all(lower, lower, limit);
    } catch { return []; }
}

/**
 * Get entity stats: top entities by type
 */
export function getEntityStats() {
    if (!db) return { total: 0, by_type: {} };
    try {
        const total = db.prepare('SELECT COUNT(*) as cnt FROM kg_entities').get();
        const totalLinks = db.prepare('SELECT COUNT(*) as cnt FROM kg_links').get();
        const byType = db.prepare(`
            SELECT type, COUNT(*) as cnt FROM kg_entities GROUP BY type ORDER BY cnt DESC
        `).all();
        const topEntities = db.prepare(`
            SELECT name, type, count FROM kg_entities ORDER BY count DESC LIMIT 20
        `).all();

        return {
            total_entities: total.cnt,
            total_links: totalLinks.cnt,
            by_type: Object.fromEntries(byType.map(r => [r.type, r.cnt])),
            top_entities: topEntities
        };
    } catch { return { total_entities: 0, total_links: 0 }; }
}

export default {
    initGraphIndex, rebuildGraphIndex, updateGraphEntry, removeGraphEntry,
    queryGraph, findRelatedEntities, getEntityStats
};
