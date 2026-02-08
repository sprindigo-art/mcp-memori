#!/usr/bin/env node
/**
 * Re-index all embeddings with front-loaded format
 * v4.1 - Improved: skip already-reindexed, verbose logging, retry on DB lock
 * 
 * Usage: node scripts/reindex-embeddings.js
 */
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REINDEX_MARKER = '2026-02-08 00:32'; // Items updated after this are already reindexed

async function main() {
    console.log('=== MCP Memory Re-Index Script v4.1 (Robust) ===');
    console.log(`Start time: ${new Date().toISOString()}`);

    // Initialize DB
    const { initDb, query, queryOne, closeDb } = await import('../src/db/index.js');
    await initDb();

    // Initialize embedding
    const { generateEmbedding, isEmbeddingAvailable } = await import('../src/utils/embedding.js');

    const available = await isEmbeddingAvailable();
    if (!available) {
        console.error('ERROR: Embedding model not available.');
        process.exit(1);
    }
    console.log('Embedding model: READY');

    // Count items that NEED re-indexing (not yet updated today)
    const needReindex = await query(
        `SELECT id, title, content, tags FROM memory_items 
         WHERE status = 'active' AND (updated_at < '2026-02-08' OR updated_at LIKE '2026-02-08T00:%')
         ORDER BY created_at ASC`
    );

    const totalActive = await queryOne(`SELECT COUNT(*) as cnt FROM memory_items WHERE status = 'active'`);
    const alreadyDone = totalActive.cnt - needReindex.length;

    console.log(`Total active items: ${totalActive.cnt}`);
    console.log(`Already re-indexed: ${alreadyDone}`);
    console.log(`Need re-indexing: ${needReindex.length}`);

    if (needReindex.length === 0) {
        console.log('All items already re-indexed! Exiting.');
        await closeDb();
        process.exit(0);
    }

    let processed = 0;
    let success = 0;
    let failed = 0;
    let skipped = 0;
    const errors = [];

    for (const item of needReindex) {
        try {
            // Build front-loaded embedding input
            const parts = [];
            parts.push(`TITLE: ${item.title}`);

            const tags = parseJsonSafe(item.tags, []);
            if (tags.length > 0) {
                parts.push(`TAGS: ${tags.join(', ')}`);
            }

            const content = item.content || '';
            const outcomeMatch = content.match(/##\s*OUTCOME[:\s]*(.*?)(?=\n##|$)/is);
            if (outcomeMatch && outcomeMatch[1]) {
                parts.push(`OUTCOME: ${outcomeMatch[1].trim().substring(0, 200)}`);
            }

            const commandMatch = content.match(/Command:\s*(.*?)(?=\n|$)/i);
            if (commandMatch && commandMatch[1]) {
                parts.push(`CMD: ${commandMatch[1].trim().substring(0, 150)}`);
            }

            parts.push(content.substring(0, 800));
            const textToEmbed = parts.join(' | ');

            // Generate embedding with retry
            let result = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
                result = await generateEmbedding(textToEmbed);
                if (result && result.embedding) break;
                if (attempt < 3) {
                    console.log(`  Retry ${attempt}/3 for: ${item.title.substring(0, 40)}`);
                    await sleep(500 * attempt); // Backoff
                }
            }

            if (result && result.embedding) {
                // Update with retry for DB lock
                for (let dbAttempt = 1; dbAttempt <= 3; dbAttempt++) {
                    try {
                        await query(
                            `UPDATE memory_items SET embedding = ?, updated_at = datetime('now') WHERE id = ?`,
                            [JSON.stringify(result.embedding), item.id]
                        );
                        success++;
                        break;
                    } catch (dbErr) {
                        if (dbErr.message.includes('SQLITE_BUSY') && dbAttempt < 3) {
                            console.log(`  DB busy, retry ${dbAttempt}/3...`);
                            await sleep(1000 * dbAttempt);
                        } else {
                            throw dbErr;
                        }
                    }
                }
            } else {
                failed++;
                const reason = result?.fallbackReason || 'null_embedding';
                errors.push({ id: item.id, title: item.title.substring(0, 50), reason });
                console.error(`  FAILED: ${item.id} (${item.title.substring(0, 40)}) - ${reason}`);
            }
        } catch (err) {
            failed++;
            errors.push({ id: item.id, title: item.title.substring(0, 50), reason: err.message });
            console.error(`  ERROR: ${item.id} (${item.title.substring(0, 40)}) - ${err.message}`);
        }

        processed++;

        // Progress every 50 items
        if (processed % 50 === 0) {
            const pct = Math.round((processed / needReindex.length) * 100);
            console.log(`  [${pct}%] ${processed}/${needReindex.length} | OK: ${success} | FAIL: ${failed}`);
        }
    }

    // Final report
    console.log(`\n========================================`);
    console.log(`=== Re-Index Complete ===`);
    console.log(`========================================`);
    console.log(`Total needed: ${needReindex.length}`);
    console.log(`Success: ${success}`);
    console.log(`Failed: ${failed}`);
    console.log(`Previously done: ${alreadyDone}`);
    console.log(`Grand total indexed: ${success + alreadyDone}/${totalActive.cnt}`);

    if (errors.length > 0) {
        console.log(`\n--- Errors ---`);
        for (const e of errors.slice(0, 20)) {
            console.log(`  ${e.id} | ${e.title} | ${e.reason}`);
        }
        if (errors.length > 20) console.log(`  ... and ${errors.length - 20} more errors`);
    }

    console.log(`\nEnd time: ${new Date().toISOString()}`);

    await closeDb();
    process.exit(failed > 0 ? 1 : 0);
}

function parseJsonSafe(value, defaultValue) {
    if (!value) return defaultValue;
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch {
        return defaultValue;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
});
