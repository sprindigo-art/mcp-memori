/**
 * LAYER 2: Lightweight Knowledge Graph - Relation Management
 * Simple graph for multi-hop reasoning without heavy graph engine
 * @module retrieval/graph
 */
import { query, queryOne } from '../db/index.js';
import { v4 as uuidv4 } from 'uuid';
import { now } from '../utils/time.js';
import logger from '../utils/logger.js';

/**
 * Relation types supported
 * @type {string[]}
 */
export const RELATION_TYPES = ['causes', 'depends_on', 'contradicts', 'supersedes', 'related_to'];

/**
 * Add a relation between two memory items
 * @param {object} params
 * @param {string} params.fromId - Source memory item ID
 * @param {string} params.toId - Target memory item ID
 * @param {string} params.relation - Relation type
 * @param {number} params.weight - Relation strength (0-1)
 * @param {object} params.metadata - Additional metadata
 * @returns {Promise<{id: string, created: boolean}>}
 */
export async function addRelation({ fromId, toId, relation, weight = 1.0, metadata = {} }) {
    if (!RELATION_TYPES.includes(relation)) {
        throw new Error(`Invalid relation type: ${relation}. Valid types: ${RELATION_TYPES.join(', ')}`);
    }

    // Check if relation already exists
    const existing = await queryOne(
        `SELECT id FROM memory_links WHERE from_id = ? AND to_id = ? AND relation = ?`,
        [fromId, toId, relation]
    );

    if (existing) {
        // Update weight/metadata
        await query(
            `UPDATE memory_links SET weight = ?, metadata_json = ? WHERE id = ?`,
            [weight, JSON.stringify(metadata), existing.id]
        );
        return { id: existing.id, created: false };
    }

    // Create new relation
    const id = uuidv4();
    await query(
        `INSERT INTO memory_links (id, from_id, to_id, relation, weight, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, fromId, toId, relation, weight, JSON.stringify(metadata), now()]
    );

    logger.info('Relation added', { id, fromId, toId, relation });
    return { id, created: true };
}

/**
 * Get all relations for a memory item (outgoing and incoming)
 * @param {string} itemId
 * @returns {Promise<{outgoing: Array, incoming: Array}>}
 */
export async function getRelations(itemId) {
    const outgoing = await query(
        `SELECT ml.*, m.title as target_title, m.type as target_type, m.status as target_status
         FROM memory_links ml
         JOIN memory_items m ON ml.to_id = m.id
         WHERE ml.from_id = ?`,
        [itemId]
    );

    const incoming = await query(
        `SELECT ml.*, m.title as source_title, m.type as source_type, m.status as source_status
         FROM memory_links ml
         JOIN memory_items m ON ml.from_id = m.id
         WHERE ml.to_id = ?`,
        [itemId]
    );

    return { outgoing, incoming };
}

/**
 * Multi-hop traversal - find related items up to N hops
 * Used for context enrichment in summarize/search
 * @param {string} startId - Starting item ID
 * @param {number} maxHops - Maximum traversal depth (default 2)
 * @param {string[]} followRelations - Which relation types to follow
 * @returns {Promise<Array<{id: string, hop: number, path: string[]}>>}
 */
export async function traverseGraph(startId, maxHops = 2, followRelations = RELATION_TYPES) {
    const visited = new Set([startId]);
    const results = [];
    let currentLevel = [{ id: startId, hop: 0, path: [startId] }];

    for (let hop = 1; hop <= maxHops; hop++) {
        const nextLevel = [];

        for (const node of currentLevel) {
            // Get outgoing relations
            const relations = await query(
                `SELECT to_id, relation, weight FROM memory_links 
                 WHERE from_id = ? AND relation IN (${followRelations.map(() => '?').join(',')})`,
                [node.id, ...followRelations]
            );

            for (const rel of relations) {
                if (!visited.has(rel.to_id)) {
                    visited.add(rel.to_id);
                    const newNode = {
                        id: rel.to_id,
                        hop,
                        path: [...node.path, rel.to_id],
                        relation: rel.relation,
                        weight: rel.weight
                    };
                    results.push(newNode);
                    nextLevel.push(newNode);
                }
            }
        }

        currentLevel = nextLevel;
        if (currentLevel.length === 0) break;
    }

    return results;
}

/**
 * Find conflicts between items (contradicts relations)
 * @param {string} projectId
 * @param {string} tenantId
 * @returns {Promise<Array>}
 */
export async function findConflicts(projectId, tenantId) {
    return query(
        `SELECT ml.*, 
                m1.title as from_title, m1.content as from_content,
                m2.title as to_title, m2.content as to_content
         FROM memory_links ml
         JOIN memory_items m1 ON ml.from_id = m1.id
         JOIN memory_items m2 ON ml.to_id = m2.id
         WHERE ml.relation = 'contradicts'
         AND m1.project_id = ? AND m1.tenant_id = ?
         AND m1.status = 'active' AND m2.status = 'active'`,
        [projectId, tenantId]
    );
}

/**
 * Find superseded items (for cleanup)
 * @param {string} projectId
 * @param {string} tenantId
 * @returns {Promise<Array>}
 */
export async function findSuperseded(projectId, tenantId) {
    return query(
        `SELECT ml.to_id as superseded_id, m.title, m.type
         FROM memory_links ml
         JOIN memory_items m ON ml.to_id = m.id
         WHERE ml.relation = 'supersedes'
         AND m.project_id = ? AND m.tenant_id = ?
         AND m.status = 'active'`,
        [projectId, tenantId]
    );
}

/**
 * Auto-detect potential relations from content similarity
 * (Lightweight heuristic, not full NLP)
 * @param {string} itemId
 * @param {string} projectId
 * @param {string} tenantId
 * @returns {Promise<Array<{toId: string, suggestedRelation: string, confidence: number}>>}
 */
export async function suggestRelations(itemId, projectId, tenantId) {
    const item = await queryOne(
        `SELECT id, title, content, type FROM memory_items WHERE id = ?`,
        [itemId]
    );

    if (!item) return [];

    // Find items with similar keywords
    const keywords = extractKeywords(item.title + ' ' + item.content);
    if (keywords.length === 0) return [];

    const ftsQuery = keywords.map(k => `"${k}"`).join(' OR ');

    const similar = await query(
        `SELECT m.id, m.title, m.type, bm25(memory_items_fts) as score
         FROM memory_items_fts fts
         JOIN memory_items m ON fts.id = m.id
         WHERE memory_items_fts MATCH ?
         AND m.project_id = ? AND m.tenant_id = ?
         AND m.id != ?
         AND m.status = 'active'
         ORDER BY score LIMIT 5`,
        [ftsQuery, projectId, tenantId, itemId]
    );

    // Suggest relations based on type combinations
    return similar.map(s => {
        let suggestedRelation = 'related_to';
        let confidence = 0.5;

        if (item.type === 'decision' && s.type === 'state') {
            suggestedRelation = 'causes';
            confidence = 0.7;
        } else if (item.type === 'state' && s.type === 'decision') {
            suggestedRelation = 'depends_on';
            confidence = 0.7;
        } else if (item.type === s.type) {
            // Same type - might supersede
            suggestedRelation = 'supersedes';
            confidence = 0.4;
        }

        return {
            toId: s.id,
            toTitle: s.title,
            suggestedRelation,
            confidence
        };
    });
}

/**
 * Simple keyword extraction
 */
function extractKeywords(text) {
    const stopwords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
        'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
        'for', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'from', 'with', 'by', 'of', 'this',
        'that', 'it', 'its', 'yang', 'dan', 'atau', 'untuk', 'di', 'ke', 'dari', 'dengan', 'ini', 'itu']);

    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopwords.has(w))
        .slice(0, 10);
}

export default {
    RELATION_TYPES,
    addRelation,
    getRelations,
    traverseGraph,
    findConflicts,
    findSuperseded,
    suggestRelations
};
