/**
 * memory.upsert - Insert or update memory items (idempotent)
 * v4.0 - Front-Loading Embedding + Maintenance Counter + Cache Invalidation
 * @module mcp/tools/memory.upsert
 */
import { query, queryOne, transaction } from '../../db/index.js';
import { withLock } from '../../concurrency/lock.js';
import { retry, isRetryableError } from '../../concurrency/retry.js';
import { checkIdempotency } from '../../concurrency/idempotency.js';
import { contentHash, idempotencyHash } from '../../utils/hash.js';
import { generateEmbedding, isEmbeddingAvailable } from '../../utils/embedding.js';
import { normalizeTags, extractKeywords } from '../../utils/normalize.js';
import { now } from '../../utils/time.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger.js';
import { getMinimalForensicMeta } from '../../utils/forensic.js';
import { suggestRelations, addRelation } from '../../retrieval/graph.js';
import { invalidateCache } from '../../utils/cache.js';

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
                        provenance_json: { type: 'object', description: 'Provenance info' },
                        success: { type: 'boolean', description: 'Whether the action succeeded (boosts usefulness_score)' }
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
/**
 * ANTI-LUPA FORMAT VALIDATION v3.0 — STRICT MODE
 * Episode WAJIB punya Command: DAN ## OUTCOME
 * Arrow Result / COMMANDS EXECUTED TIDAK LAGI diterima
 * @param {object} item - Memory item
 * @returns {object} { valid: boolean, warnings: string[] }
 */
function validateMemoryFormat(item) {
    const warnings = [];
    const content = item.content || '';
    const type = item.type;

    // RUNBOOK: MUST have exact commands + steps
    if (type === 'runbook') {
        if (!content.includes('Command:') && !content.includes('command:')) {
            warnings.push('RUNBOOK harus berisi "Command:" dengan exact command. Format: "Command: [EXACT COMMAND]"');
        }
        if (!content.includes('Step') && !content.includes('STEP')) {
            warnings.push('RUNBOOK harus berisi step-by-step. Format: "## STEP 1:", "## STEP 2:"');
        }
    }

    // EPISODE: MUST have Command: AND ## OUTCOME (STRICT v3.0)
    if (type === 'episode') {
        // WAJIB: Command: atau command: (case-insensitive check)
        const hasCommand = content.includes('Command:') || content.includes('command:');
        if (!hasCommand) {
            warnings.push('EPISODE WAJIB berisi "Command:" dengan exact command yang dieksekusi. Format: "Command: [EXACT COMMAND]"');
        }

        // WAJIB: ## OUTCOME section
        const hasOutcome = /##\s*OUTCOME/i.test(content);
        if (!hasOutcome) {
            warnings.push('EPISODE WAJIB berisi "## OUTCOME" section. Format: "## OUTCOME: [RESULT]"');
        }

        // Check for lazy status-only format (FORBIDDEN)
        const lazyPatterns = [
            /^(✅|❌|⚠️)\s*\w+\s+(AKTIF|aktif|BERHASIL|berhasil|GAGAL|gagal)/m,
            /tunnel AKTIF/i,
            /berhasil upload/i
        ];
        for (const pattern of lazyPatterns) {
            if (pattern.test(content) && !hasCommand) {
                warnings.push('DILARANG: Status-only tanpa exact command. Harus ada "Command:" di setiap step.');
            }
        }
    }

    // FACT (credentials): MUST have HOW TO USE
    if (type === 'fact' && (
        content.toLowerCase().includes('credential') ||
        content.toLowerCase().includes('password') ||
        content.toLowerCase().includes('username')
    )) {
        if (!content.includes('HOW TO USE') && !content.includes('Example:') && !content.includes('Command:')) {
            warnings.push('FACT credentials harus berisi "HOW TO USE:" dengan contoh command penggunaan.');
        }
    }

    return {
        valid: warnings.length === 0,
        warnings: warnings
    };
}

export async function execute(params) {
    const traceId = uuidv4();
    const { items, tenant_id: tenantId = 'local-user' } = params;

    if (!items || items.length === 0) {
        return {
            upserted: [],
            meta: { trace_id: traceId, error: 'No items provided' }
        };
    }

    // ANTI-LUPA: Validate all items format first
    const formatWarnings = [];
    // Collect validation results
    const criticalErrors = [];

    for (const item of items) {
        const validation = validateMemoryFormat(item);
        if (!validation.valid) {
            // Check if this is a CRITICAL format error (runbook/episode without commands)
            const isCritical = (item.type === 'runbook' || item.type === 'episode') &&
                validation.warnings.some(w =>
                    w.includes('Command:') ||
                    w.includes('exact command') ||
                    w.includes('step-by-step')
                );

            if (isCritical) {
                criticalErrors.push({
                    title: item.title,
                    type: item.type,
                    errors: validation.warnings,
                    resolution: 'Tambahkan "Command: [EXACT COMMAND]" dan step-by-step untuk setiap action'
                });
            } else {
                // Non-critical: just warning
                formatWarnings.push({
                    title: item.title,
                    type: item.type,
                    warnings: validation.warnings
                });
            }
        }
    }

    // HARD BLOCK: Reject if critical format errors found
    if (criticalErrors.length > 0) {
        logger.error('ANTI-LUPA HARD BLOCK - Format tidak lengkap', {
            trace_id: traceId,
            blocked_items: criticalErrors.length,
            details: criticalErrors
        });

        throw new Error(
            `ANTI-LUPA HARD BLOCK: ${criticalErrors.length} item(s) DITOLAK karena format tidak lengkap!\n` +
            `Items: ${criticalErrors.map(e => `"${e.title}" (${e.type})`).join(', ')}\n` +
            `Errors: ${criticalErrors.flatMap(e => e.errors).join('; ')}\n` +
            `SOLUSI: Pastikan setiap runbook/episode memiliki "Command:" dengan exact command yang dieksekusi!`
        );
    }

    // Log warnings for non-critical issues (still allow save)
    if (formatWarnings.length > 0) {
        logger.warn('ANTI-LUPA FORMAT WARNING (non-blocking)', {
            trace_id: traceId,
            items_with_issues: formatWarnings.length,
            details: formatWarnings
        });
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
    const hasErrors = results.some(r => r.status === 'error');
    await writeAuditLog(traceId, 'memory_upsert',
        { item_count: items.length },
        { upserted_count: results.filter(r => r.id).length },
        items[0]?.project_id || 'unknown',
        tenantId,
        hasErrors
    );

    // MAINTENANCE COUNTER: Increment and check if maintenance needed
    let maintenanceWarning = null;
    try {
        const successCount = results.filter(r => r.id).length;
        if (successCount > 0) {
            await query(
                `UPDATE system_state SET value = CAST(value AS INTEGER) + ?, updated_at = datetime('now') WHERE key = 'upsert_count'`,
                [successCount]
            );
            const counter = await queryOne(`SELECT value FROM system_state WHERE key = 'upsert_count'`);
            const count = parseInt(counter?.value || '0', 10);
            if (count > 0 && count % 50 === 0) {
                maintenanceWarning = `[SYSTEM] Maintenance recommended (${count} upserts since last clean). Run memory_maintain with actions=["dedup","clean_links","auto_guardrails"] now.`;
                logger.info('Maintenance counter triggered', { count });
            }
        }
    } catch (counterErr) {
        logger.debug('Maintenance counter update failed', { error: counterErr.message });
    }

    // Build Minimal Forensic Metadata (upsert is high-frequency, minimal bloat)
    const forensicMeta = getMinimalForensicMeta(tenantId, items[0]?.project_id || 'unknown');

    const response = {
        upserted: results,
        format_warnings: formatWarnings.length > 0 ? formatWarnings : undefined,
        meta: {
            trace_id: traceId,
            forensic: forensicMeta,
            anti_lupa_validation: formatWarnings.length === 0 ? 'PASSED' : 'WARNING - Format tidak sesuai template'
        }
    };

    // Inject maintenance warning if triggered
    if (maintenanceWarning) {
        response.maintenance_warning = maintenanceWarning;
    }

    return response;
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

                // Invalidate cache on update
                invalidateCache(existingId);

                return {
                    id: existingId,
                    version: updated.version,
                    status: updated.status,
                    action: 'updated'
                };
            }

            // TITLE-BASED MATCHING: Update existing item when title+type+project matches
            // This allows content updates for existing memory items (fixes version = 1 forever bug)
            const titleMatch = await queryOne(
                `SELECT id, version, content_hash, tags FROM memory_items 
                 WHERE title = ? COLLATE NOCASE AND type = ? AND project_id = ? AND tenant_id = ?
                 AND status = 'active'
                 ORDER BY updated_at DESC LIMIT 1`,
                [item.title, item.type, projectId, tenantId]
            );

            if (titleMatch) {
                // HISTORY BACKUP: Save current version before overwrite (rollback protection)
                try {
                    await query(
                        `INSERT INTO memory_items_history (history_id, item_id, version, title, content, tags, content_hash, usefulness_score, updated_at, reason)
                         SELECT ?, id, version, title, content, tags, content_hash, usefulness_score, updated_at, 'title_match_update'
                         FROM memory_items WHERE id = ?`,
                        [uuidv4(), titleMatch.id]
                    );
                } catch (histErr) {
                    logger.warn('History backup failed', { error: histErr.message, id: titleMatch.id });
                }

                // Regenerate embedding for new content
                let newEmbedding = null;
                try {
                    if (await isEmbeddingAvailable()) {
                        const textToEmbed = `${item.title} ${item.content}`;
                        const embResult = await generateEmbedding(textToEmbed);
                        if (embResult?.embedding) {
                            newEmbedding = embResult.embedding;
                        }
                    }
                } catch (err) {
                    logger.warn('Embedding regeneration failed on content update', { error: err.message });
                }

                // MERGE TAGS: Preserve protected tags from old item
                const oldTags = typeof titleMatch.tags === 'string'
                    ? JSON.parse(titleMatch.tags || '[]')
                    : (titleMatch.tags || []);
                const newTags = normalizeTags(item.tags);
                const PROTECTED_TAG_LIST = [
                    'critical', 'operational', 'persistence', 'credential',
                    'infrastructure', 'verified', 'access', 'exploit',
                    'root', 'tunnel', 'ssh', 'webshell', 'technique', 'shell', 'backdoor'
                ];
                const protectedFromOld = oldTags.filter(t =>
                    PROTECTED_TAG_LIST.includes(t.toLowerCase()) && !newTags.includes(t)
                );
                const mergedTags = [...newTags, ...protectedFromOld];

                // Build dynamic update - only update embedding if we generated a new one
                const updateFields = [
                    'content = ?', 'content_hash = ?', 'tags = ?',
                    'verified = ?', 'confidence = ?', 'provenance_json = ?',
                    'version = version + 1', 'updated_at = ?'
                ];
                const updateValues = [
                    item.content, hash,
                    JSON.stringify(mergedTags),
                    item.verified ? 1 : 0,
                    item.confidence || 0.5,
                    JSON.stringify(item.provenance_json || {}),
                    now()
                ];

                if (newEmbedding) {
                    updateFields.push('embedding = ?');
                    updateValues.push(JSON.stringify(newEmbedding));
                }

                updateValues.push(titleMatch.id); // for WHERE clause

                await query(
                    `UPDATE memory_items SET ${updateFields.join(', ')} WHERE id = ?`,
                    updateValues
                );

                // RE-RUN AUTO-LINKING: Refresh knowledge graph for updated content
                try {
                    const suggestions = await suggestRelations(titleMatch.id, projectId, tenantId);
                    let linksRefreshed = 0;
                    for (const suggestion of suggestions.slice(0, 3)) {
                        if (suggestion.confidence >= 0.4) {
                            try {
                                await addRelation({
                                    fromId: titleMatch.id,
                                    toId: suggestion.toId,
                                    relation: suggestion.suggestedRelation,
                                    weight: suggestion.confidence,
                                    metadata: { auto_created: true, source: 'content_update_relink' }
                                });
                                linksRefreshed++;
                            } catch (linkErr) {
                                logger.debug('Re-link failed', { error: linkErr.message });
                            }
                        }
                    }
                    if (linksRefreshed > 0) {
                        logger.info('Knowledge graph refreshed after content update', {
                            id: titleMatch.id, links_refreshed: linksRefreshed
                        });
                    }
                } catch (autoLinkErr) {
                    logger.debug('Auto-relinking skipped', { error: autoLinkErr.message });
                }

                const updated = await queryOne(
                    `SELECT version, status FROM memory_items WHERE id = ?`,
                    [titleMatch.id]
                );

                logger.info('Title-based content update', {
                    id: titleMatch.id,
                    title: item.title,
                    old_version: titleMatch.version,
                    new_version: updated.version,
                    tags_merged: protectedFromOld.length > 0,
                    trace_id: traceId
                });

                // Invalidate cache on content update
                invalidateCache(titleMatch.id);

                return {
                    id: titleMatch.id,
                    version: updated.version,
                    status: updated.status,
                    action: 'content_updated',
                    previous_content_hash: titleMatch.content_hash
                };
            }

            // FUZZY TITLE MATCHING v5.1: Fallback when exact title doesn't match
            // Solves the "99.6% items v1" problem — AI rarely writes identical titles
            // Uses keyword overlap (Jaccard >= 0.6) to find similar items
            const fuzzyMatch = await findFuzzyTitleMatch(item, projectId, tenantId);
            if (fuzzyMatch) {
                // Regenerate embedding for new content
                let newEmbedding = null;
                try {
                    if (await isEmbeddingAvailable()) {
                        const textToEmbed = buildFrontLoadedEmbeddingInput(item);
                        const embResult = await generateEmbedding(textToEmbed);
                        if (embResult?.embedding) {
                            newEmbedding = embResult.embedding;
                        }
                    }
                } catch (err) {
                    logger.warn('Embedding regen failed on fuzzy update', { error: err.message });
                }

                // MERGE TAGS: Preserve protected tags from old item
                const oldTags = typeof fuzzyMatch.tags === 'string'
                    ? JSON.parse(fuzzyMatch.tags || '[]')
                    : (fuzzyMatch.tags || []);
                const newTags = normalizeTags(item.tags);
                const PROTECTED_TAG_LIST = [
                    'critical', 'operational', 'persistence', 'credential',
                    'infrastructure', 'verified', 'access', 'exploit',
                    'root', 'tunnel', 'ssh', 'webshell', 'technique', 'shell', 'backdoor'
                ];
                const protectedFromOld = oldTags.filter(t =>
                    PROTECTED_TAG_LIST.includes(t.toLowerCase()) && !newTags.includes(t)
                );
                const mergedTags = [...newTags, ...protectedFromOld];

                // HISTORY BACKUP: Save current version before overwrite (rollback protection)
                try {
                    await query(
                        `INSERT INTO memory_items_history (history_id, item_id, version, title, content, tags, content_hash, usefulness_score, updated_at, reason)
                         SELECT ?, id, version, title, content, tags, content_hash, usefulness_score, updated_at, ?
                         FROM memory_items WHERE id = ?`,
                        [uuidv4(), `fuzzy_update:overlap=${fuzzyMatch._overlap?.toFixed(2)}`, fuzzyMatch.id]
                    );
                } catch (histErr) {
                    logger.warn('History backup failed', { error: histErr.message, id: fuzzyMatch.id });
                }

                // Build update — update title too (since it's slightly different)
                const updateFields = [
                    'title = ?', 'content = ?', 'content_hash = ?', 'tags = ?',
                    'verified = ?', 'confidence = ?', 'provenance_json = ?',
                    'version = version + 1', 'updated_at = ?'
                ];
                const updateValues = [
                    item.title, item.content, hash,
                    JSON.stringify(mergedTags),
                    item.verified ? 1 : 0,
                    item.confidence || 0.5,
                    JSON.stringify(item.provenance_json || {}),
                    now()
                ];

                // Preserve usefulness_score: keep higher of old vs base score
                if (item.success === true) {
                    updateFields.push('usefulness_score = MAX(usefulness_score, usefulness_score + 0.5)');
                } else if (item.success === false) {
                    updateFields.push('usefulness_score = MAX(usefulness_score - 0.5, -5.0)');
                }
                // If success not specified, preserve existing score (no change)

                if (newEmbedding) {
                    updateFields.push('embedding = ?');
                    updateValues.push(JSON.stringify(newEmbedding));
                }

                updateValues.push(fuzzyMatch.id);

                await query(
                    `UPDATE memory_items SET ${updateFields.join(', ')} WHERE id = ?`,
                    updateValues
                );

                // Refresh knowledge graph links
                try {
                    const suggestions = await suggestRelations(fuzzyMatch.id, projectId, tenantId);
                    for (const suggestion of suggestions.slice(0, 3)) {
                        if (suggestion.confidence >= 0.4) {
                            try {
                                await addRelation({
                                    fromId: fuzzyMatch.id,
                                    toId: suggestion.toId,
                                    relation: suggestion.suggestedRelation,
                                    weight: suggestion.confidence,
                                    metadata: { auto_created: true, source: 'fuzzy_title_relink' }
                                });
                            } catch (linkErr) {
                                logger.debug('Fuzzy re-link failed', { error: linkErr.message });
                            }
                        }
                    }
                } catch (autoLinkErr) {
                    logger.debug('Fuzzy auto-relinking skipped', { error: autoLinkErr.message });
                }

                const updated = await queryOne(
                    `SELECT version, status FROM memory_items WHERE id = ?`,
                    [fuzzyMatch.id]
                );

                logger.info('Fuzzy title match update', {
                    id: fuzzyMatch.id,
                    old_title: fuzzyMatch.title,
                    new_title: item.title,
                    overlap: fuzzyMatch._overlap,
                    old_version: fuzzyMatch.version,
                    new_version: updated.version,
                    trace_id: traceId
                });

                invalidateCache(fuzzyMatch.id);

                return {
                    id: fuzzyMatch.id,
                    version: updated.version,
                    status: updated.status,
                    action: 'fuzzy_updated',
                    matched_title: fuzzyMatch.title,
                    overlap_score: fuzzyMatch._overlap
                };
            }

            // Insert new item
            const id = uuidv4();

            // Generate embedding with FRONT-LOADING strategy (v4.0)
            // Puts Title + Tags + Outcome BEFORE content to solve 256-token truncation
            let embedding = null;
            if (await isEmbeddingAvailable()) {
                try {
                    const textToEmbed = buildFrontLoadedEmbeddingInput(item);
                    const result = await generateEmbedding(textToEmbed);
                    if (result && result.embedding) {
                        embedding = result.embedding;
                        logger.debug('Embedding generated (front-loaded)', {
                            id,
                            backend: result.backend,
                            dim: embedding.length,
                            input_length: textToEmbed.length
                        });
                    }
                } catch (err) {
                    logger.warn('Embedding generation failed', { error: err.message });
                }
            }

            // Calculate initial usefulness_score from type + success flag
            // Base scores ensure items start with meaningful ranking weight
            const BASE_SCORES = { fact: 0.5, runbook: 0.5, decision: 0.2, state: 0.2, episode: 0.2 };
            let initialScore = BASE_SCORES[item.type] || 0.2;
            if (item.success === true) {
                initialScore += 1.0;  // Success boost (fact success = 1.5, episode success = 1.2)
            } else if (item.success === false) {
                initialScore -= 0.5;  // Failure penalty (fact fail = 0.0, episode fail = -0.3)
            }

            await query(
                `INSERT INTO memory_items (
          id, tenant_id, project_id, type, title, content, tags,
          embedding, verified, confidence, provenance_json, content_hash,
          usefulness_score, created_at, updated_at, last_used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
                    initialScore,
                    now(),
                    now(),
                    now()
                ]
            );

            // AUTO-LINKING v1.0: Create knowledge graph links for better retrieval
            // Run async to not block the main operation
            try {
                const suggestions = await suggestRelations(id, projectId, tenantId);
                const linksCreated = [];

                // Create top 3 suggested relations
                for (const suggestion of suggestions.slice(0, 3)) {
                    if (suggestion.confidence >= 0.4) {
                        try {
                            await addRelation({
                                fromId: id,
                                toId: suggestion.toId,
                                relation: suggestion.suggestedRelation,
                                weight: suggestion.confidence,
                                metadata: { auto_created: true, source: 'upsert_auto_link' }
                            });
                            linksCreated.push({
                                to: suggestion.toId,
                                relation: suggestion.suggestedRelation
                            });
                        } catch (linkErr) {
                            logger.debug('Auto-link creation failed', { error: linkErr.message });
                        }
                    }
                }

                if (linksCreated.length > 0) {
                    logger.info('Auto-links created', { id, links_count: linksCreated.length });
                }
            } catch (autoLinkErr) {
                logger.debug('Auto-linking skipped', { error: autoLinkErr.message });
            }

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
 * Write to audit log with is_error flag
 */
async function writeAuditLog(traceId, toolName, request, response, projectId, tenantId, isError = false) {
    try {
        await query(
            `INSERT INTO audit_log (id, trace_id, ts, tool_name, request_json, response_json, project_id, tenant_id, is_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                uuidv4(),
                traceId,
                now(),
                toolName,
                JSON.stringify(request),
                JSON.stringify(response),
                projectId,
                tenantId,
                isError ? 1 : 0
            ]
        );
    } catch (err) {
        logger.warn('Audit log write failed', { error: err.message });
    }
}

/**
 * Build front-loaded embedding input string
 * Strategy: Put Title + Tags + Outcome BEFORE Content
 * This ensures the most important signals are within the 256-token window
 * of all-MiniLM-L6-v2
 * @param {object} item - Memory item
 * @returns {string} Optimized embedding input
 */
function buildFrontLoadedEmbeddingInput(item) {
    const parts = [];

    // 1. Title (always first - highest signal)
    parts.push(`TITLE: ${item.title}`);

    // 2. Tags (high signal density)
    const tags = normalizeTags(item.tags);
    if (tags.length > 0) {
        parts.push(`TAGS: ${tags.join(', ')}`);
    }

    // 3. Extract Outcome from content (for episodes) - critical info often at end
    const content = item.content || '';
    const outcomeMatch = content.match(/##\s*OUTCOME[:\s]*(.*?)(?=\n##|$)/is);
    if (outcomeMatch && outcomeMatch[1]) {
        const outcome = outcomeMatch[1].trim().substring(0, 200);
        parts.push(`OUTCOME: ${outcome}`);
    }

    // 4. Extract Command from content (for episodes/runbooks)
    const commandMatch = content.match(/Command:\s*(.*?)(?=\n|$)/i);
    if (commandMatch && commandMatch[1]) {
        parts.push(`CMD: ${commandMatch[1].trim().substring(0, 150)}`);
    }

    // 5. Content body (truncated to fit remaining token budget)
    // Front-loaded parts ~100-200 chars, remaining budget ~800 chars for content
    parts.push(content.substring(0, 800));

    return parts.join(' | ');
}

/**
 * Find a fuzzy title match for update instead of creating duplicates
 * v5.1: Solves the "99.6% items v1" problem
 * 
 * Strategy:
 * 1. Extract keywords from new title
 * 2. Search recent items with same type+project
 * 3. Calculate Jaccard keyword overlap
 * 4. Return match only if ONE strong candidate (>= 60% overlap)
 * 5. If ambiguous (multiple candidates >= 60%), return null (create new = safe default)
 * 
 * @param {object} item - New item being upserted
 * @param {string} projectId 
 * @param {string} tenantId 
 * @returns {object|null} - Matching item or null
 */
async function findFuzzyTitleMatch(item, projectId, tenantId) {
    const newKeywords = extractKeywords(item.title);

    // Need at least 2 keywords for meaningful comparison
    if (newKeywords.length < 2) return null;

    let candidates = [];

    // STRATEGY 1: Use FTS to find candidates based on title keywords (more targeted, no time limit)
    try {
        const ftsQuery = newKeywords.slice(0, 5).map(k => `"${k}"*`).join(' OR ');
        const ftsResults = await query(
            `SELECT m.id, m.title, m.version, m.content_hash, m.tags, m.usefulness_score
             FROM memory_items_fts fts
             JOIN memory_items m ON fts.id = m.id
             WHERE memory_items_fts MATCH ?
               AND m.type = ? AND m.project_id = ? AND m.tenant_id = ? AND m.status = 'active'
             LIMIT 100`,
            [ftsQuery, item.type, projectId, tenantId]
        );
        if (ftsResults && ftsResults.length > 0) {
            candidates = ftsResults;
        }
    } catch (ftsErr) {
        logger.debug('FTS fuzzy search failed, falling back to recent items', { error: ftsErr.message });
    }

    // STRATEGY 2: Fallback to recent items if FTS found nothing (covers FTS desync)
    if (candidates.length === 0) {
        candidates = await query(
            `SELECT id, title, version, content_hash, tags, usefulness_score FROM memory_items 
             WHERE type = ? AND project_id = ? AND tenant_id = ? AND status = 'active'
             ORDER BY updated_at DESC LIMIT 50`,
            [item.type, projectId, tenantId]
        );
    }

    if (!candidates || candidates.length === 0) return null;

    // SAFEGUARD: Extract success/failure status from titles
    // Prevent merging [FAILED] with [SUCCESS] items
    const newTitleLower = item.title.toLowerCase();
    const newIsFailure = newTitleLower.includes('[failed]') || newTitleLower.includes('[guardrail]') || newTitleLower.includes('[blocked]');
    const newIsSuccess = newTitleLower.includes('[success]') || newTitleLower.includes('[achieved]');

    let bestMatch = null;
    let bestOverlap = 0;
    let secondBestOverlap = 0;

    for (const candidate of candidates) {
        const candidateKeywords = extractKeywords(candidate.title);
        if (candidateKeywords.length < 2) continue;

        // SAFEGUARD: Skip if success/failure status differs
        const candTitleLower = candidate.title.toLowerCase();
        const candIsFailure = candTitleLower.includes('[failed]') || candTitleLower.includes('[guardrail]') || candTitleLower.includes('[blocked]');
        const candIsSuccess = candTitleLower.includes('[success]') || candTitleLower.includes('[achieved]');
        if ((newIsFailure && candIsSuccess) || (newIsSuccess && candIsFailure)) {
            continue; // Different outcome status = different items
        }

        // Calculate Jaccard similarity: intersection / union
        const intersection = newKeywords.filter(k => candidateKeywords.includes(k));
        const unionSet = new Set([...newKeywords, ...candidateKeywords]);
        const overlap = intersection.length / unionSet.size;

        if (overlap > bestOverlap) {
            secondBestOverlap = bestOverlap;
            bestOverlap = overlap;
            bestMatch = { ...candidate, _overlap: overlap };
        } else if (overlap > secondBestOverlap) {
            secondBestOverlap = overlap;
        }
    }

    // SAFETY CHECKS:
    // 1. Best match must be >= 60% overlap
    if (!bestMatch || bestOverlap < 0.6) return null;

    // 2. If second-best is also >= 55%, it's AMBIGUOUS — don't update
    //    This prevents wrong matches when multiple similar items exist
    if (secondBestOverlap >= 0.55) {
        logger.debug('Fuzzy match ambiguous, creating new item', {
            best: bestOverlap.toFixed(2),
            second: secondBestOverlap.toFixed(2),
            title: item.title
        });
        return null;
    }

    // 3. Must not be exact same content (that's handled by contentHash check already)
    const newHash = contentHash(item.content);
    if (bestMatch.content_hash === newHash) return null;

    logger.info('Fuzzy title match found', {
        new_title: item.title,
        matched_title: bestMatch.title,
        overlap: bestOverlap.toFixed(2),
        matched_id: bestMatch.id
    });

    return bestMatch;
}

export default { definition, execute };
