/**
 * memory.upsert - Insert or update memory items (idempotent)
 * @module mcp/tools/memory.upsert
 */
import { query, queryOne, transaction } from '../../db/index.js';
import { withLock } from '../../concurrency/lock.js';
import { retry, isRetryableError } from '../../concurrency/retry.js';
import { checkIdempotency } from '../../concurrency/idempotency.js';
import { contentHash, idempotencyHash } from '../../utils/hash.js';
import { generateEmbedding, isEmbeddingAvailable } from '../../utils/embedding.js';
import { normalizeTags } from '../../utils/normalize.js';
import { now } from '../../utils/time.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger.js';
import { getForensicMeta } from '../../utils/forensic.js';

/**
 * Tool definition for MCP
 */
export const definition = {
    name: 'memory_upsert',
    description: 'Simpan atau update memori (idempotent, concurrency-safe)',
    inputSchema: {
        type: 'object',
        properties: {
            items: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        type: {
                            type: 'string',
                            enum: ['fact', 'state', 'decision', 'runbook', 'episode'],
                            description: 'Memory type'
                        },
                        project_id: { type: 'string', description: 'Project ID' },
                        title: { type: 'string', description: 'Title' },
                        content: { type: 'string', description: 'Content' },
                        tags: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Tags'
                        },
                        verified: { type: 'boolean', description: 'Is verified' },
                        confidence: { type: 'number', description: 'Confidence 0-1' },
                        provenance_json: { type: 'object', description: 'Provenance info' }
                    },
                    required: ['type', 'project_id', 'title', 'content']
                },
                description: 'Memory items to upsert'
            }
        },
        required: ['items']
    }
};

/**
 * Execute memory upsert
 * @param {object} params
 * @returns {Promise<object>}
 */
export async function execute(params) {
    const traceId = uuidv4();
    const { items, tenant_id: tenantId = 'local-user' } = params;

    if (!items || items.length === 0) {
        return {
            upserted: [],
            meta: { trace_id: traceId, error: 'No items provided' }
        };
    }

    const results = [];

    for (const item of items) {
        try {
            const result = await upsertItem(item, tenantId, traceId);
            results.push(result);
        } catch (err) {
            logger.error('Upsert item error', {
                error: err.message,
                title: item.title,
                trace_id: traceId
            });
            results.push({
                id: null,
                version: 0,
                status: 'error',
                error: err.message
            });
        }
    }

    // Write audit log
    await writeAuditLog(traceId, 'memory_upsert',
        { item_count: items.length },
        { upserted_count: results.filter(r => r.id).length },
        items[0]?.project_id || 'unknown',
        tenantId
    );

    // Build Forensic Metadata
    const forensicMeta = await getForensicMeta(tenantId, items[0]?.project_id || 'unknown');

    return {
        upserted: results,
        meta: {
            trace_id: traceId,
            forensic: forensicMeta
        }
    };
}

/**
 * Upsert a single item with locking and retry
 * @param {object} item 
 * @param {string} tenantId 
 * @param {string} traceId 
 * @returns {Promise<object>}
 */
async function upsertItem(item, tenantId, traceId) {
    const projectId = item.project_id || 'default';

    return withLock(`upsert:${projectId}`, async () => {
        return retry(async () => {
            // Calculate content hash
            const hash = contentHash(item.content);

            // Check idempotency
            const { exists, existingId, existingVersion } = await checkIdempotency({
                tenant_id: tenantId,
                project_id: projectId,
                type: item.type,
                content: item.content,
                content_hash: hash
            });

            if (exists) {
                // Update existing item
                await query(
                    `UPDATE memory_items SET 
           title = ?,
           tags = ?,
           verified = ?,
           confidence = ?,
           provenance_json = ?,
           version = version + 1,
           updated_at = ?
           WHERE id = ?`,
                    [
                        item.title,
                        JSON.stringify(normalizeTags(item.tags)),
                        item.verified ? 1 : 0,
                        item.confidence || 0.5,
                        JSON.stringify(item.provenance_json || {}),
                        now(),
                        existingId
                    ]
                );

                // Get updated version
                const updated = await queryOne(
                    `SELECT version, status FROM memory_items WHERE id = ?`,
                    [existingId]
                );

                return {
                    id: existingId,
                    version: updated.version,
                    status: updated.status,
                    action: 'updated'
                };
            }

            // Insert new item
            const id = uuidv4();

            // Generate embedding if available (v3.2)
            let embedding = null;
            if (await isEmbeddingAvailable()) {
                try {
                    const textToEmbed = `${item.title} ${item.content}`;
                    const result = await generateEmbedding(textToEmbed);
                    if (result && result.embedding) {
                        embedding = result.embedding;
                        logger.debug('Embedding generated', {
                            id,
                            backend: result.backend,
                            dim: embedding.length
                        });
                    }
                } catch (err) {
                    logger.warn('Embedding generation failed', { error: err.message });
                }
            }

            await query(
                `INSERT INTO memory_items (
          id, tenant_id, project_id, type, title, content, tags,
          embedding, verified, confidence, provenance_json, content_hash,
          created_at, updated_at, last_used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    id,
                    tenantId,
                    projectId,
                    item.type,
                    item.title,
                    item.content,
                    JSON.stringify(normalizeTags(item.tags)),
                    embedding ? JSON.stringify(embedding) : null,
                    item.verified ? 1 : 0,
                    item.confidence || 0.5,
                    JSON.stringify(item.provenance_json || {}),
                    hash,
                    now(),
                    now(),
                    now()
                ]
            );

            return {
                id,
                version: 1,
                status: 'active',
                action: 'created'
            };

        }, {
            maxRetries: 5,
            shouldRetry: isRetryableError
        });
    });
}

/**
 * Write to audit log
 */
async function writeAuditLog(traceId, toolName, request, response, projectId, tenantId) {
    try {
        await query(
            `INSERT INTO audit_log (id, trace_id, ts, tool_name, request_json, response_json, project_id, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                uuidv4(),
                traceId,
                now(),
                toolName,
                JSON.stringify(request),
                JSON.stringify(response),
                projectId,
                tenantId
            ]
        );
    } catch (err) {
        logger.warn('Audit log write failed', { error: err.message });
    }
}

export default { definition, execute };
