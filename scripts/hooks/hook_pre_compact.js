#!/usr/bin/env node
/**
 * PreCompact hook — fire BEFORE Claude Code compacts context.
 *
 * Goals:
 *  1. Force-flush OS filesystem buffer so _AUTO_LOG guaranteed on disk.
 *  2. Append a compaction marker to _AUTO_LOG for post-mortem forensics.
 *  3. Log warning if post-compaction state hint is needed.
 *
 * Hook is fire-and-forget — compaction proceeds regardless of output.
 */
import { readFileSync, existsSync, openSync, fsyncSync, closeSync } from 'fs';
import { join } from 'path';
import { readStdinJson, hookLog, resolveActiveTarget, callAutolog } from './hook_lib.js';
import { RUNBOOKS_DIR, titleToFilename, findByTitle, findByFuzzyTitle } from '../../src/storage/files.js';

function findRunbookPath(target) {
    if (!target) return null;
    const title = target.startsWith('[') ? target : `[RUNBOOK] ${target}`;
    const filename = titleToFilename(title);
    let filepath = join(RUNBOOKS_DIR, filename);
    if (existsSync(filepath)) return filepath;
    const byTitle = findByTitle(title);
    if (byTitle) return byTitle;
    const fuzzy = findByFuzzyTitle(title);
    if (fuzzy) return fuzzy;
    return null;
}

async function main() {
    const input = readStdinJson();
    const trigger = input?.trigger || 'unknown'; // "auto" or "manual"
    const target = resolveActiveTarget();

    try {
        // 1. Append compaction marker to _AUTO_LOG for post-mortem forensic
        await callAutolog({
            target,
            entry: `COMPACTION TRIGGERED (trigger=${trigger}) — state BEFORE compact preserved in this log`,
            event_type: 'pre_compact',
            tool_name: 'claude-code'
        });

        // 2. fsync runbook file to ensure OS write buffer flushed to disk
        if (target) {
            const filepath = findRunbookPath(target);
            if (filepath && existsSync(filepath)) {
                try {
                    const fd = openSync(filepath, 'r+');
                    fsyncSync(fd);
                    closeSync(fd);
                    hookLog('INFO', 'PreCompact fsync OK', { filepath: filepath.split('/').pop() });
                } catch (fsyncErr) {
                    hookLog('WARN', 'PreCompact fsync failed (non-fatal)', { error: fsyncErr?.message });
                }
            }
        }

        hookLog('INFO', 'PreCompact processed', { target: target || 'none', trigger });
    } catch (err) {
        hookLog('ERROR', 'PreCompact exception', { error: err?.message });
    }

    process.exit(0);
}

main().catch((err) => {
    hookLog('FATAL', 'PreCompact fatal', { error: err?.message });
    process.exit(0);
});
