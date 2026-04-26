#!/usr/bin/env node
/**
 * PostToolUse hook — auto-capture every non-read-only tool call into
 * section ## _AUTO_LOG of active target runbook.
 *
 * CONTRACT (Claude Code hook):
 * - Input: stdin JSON { tool_name, tool_input, tool_response, ... }
 * - Output: exit 0 (always, never block pipeline)
 * - Side effect: append compact entry to runbook
 *
 * HARD CONSTRAINTS:
 * - Never writes to section state (memory_autolog enforces _AUTO_LOG only)
 * - Scrubs password/token/JWT patterns via scrubber.js
 * - Truncates to 3KB max per entry
 * - Dedup last 5 entries (anti-repeat spam)
 */
import {
    readStdinJson, hookLog, resolveActiveTarget, callAutolog,
    cleanForLog, shouldLogTool, formatToolInput, formatToolResponse
} from './hook_lib.js';
import { createHash } from 'crypto';
import { existsSync } from 'fs';

const OBS_DB_PATH = '/home/kali/Desktop/mcp-memori/data/search_index.db';

async function writeObservation({ runbook_id, tool_name, tool_input_summary, tool_response_summary }) {
    try {
        if (!existsSync(OBS_DB_PATH)) return false;
        let Database;
        try {
            Database = (await import('/home/kali/Desktop/mcp-memori/node_modules/better-sqlite3/lib/index.js')).default;
        } catch {
            try { Database = (await import('better-sqlite3')).default; } catch { return false; }
        }

        const hashInput = (tool_name || '') + '::' + (tool_input_summary || '').substring(0, 200);
        const contentHash = createHash('sha256').update(hashInput, 'utf8').digest('hex');

        const obsDb = new Database(OBS_DB_PATH);
        obsDb.pragma('journal_mode = WAL');
        obsDb.pragma('busy_timeout = 3000');

        obsDb.exec(`CREATE TABLE IF NOT EXISTS observations (
            id INTEGER PRIMARY KEY AUTOINCREMENT, runbook_id TEXT, tool_name TEXT,
            tool_input_summary TEXT, tool_response_summary TEXT,
            content_hash TEXT UNIQUE, timestamp TEXT DEFAULT CURRENT_TIMESTAMP
        )`);

        const existing = obsDb.prepare(
            "SELECT id FROM observations WHERE content_hash = ? AND timestamp > datetime('now', '-30 seconds')"
        ).get(contentHash);

        if (!existing) {
            obsDb.prepare(
                `INSERT OR IGNORE INTO observations (runbook_id, tool_name, tool_input_summary, tool_response_summary, content_hash, timestamp)
                 VALUES (?, ?, ?, ?, ?, datetime('now'))`
            ).run(
                runbook_id || null,
                (tool_name || 'unknown').substring(0, 100),
                (tool_input_summary || '').substring(0, 200),
                (tool_response_summary || '').substring(0, 300),
                contentHash
            );
        }
        obsDb.close();
        return true;
    } catch (err) {
        hookLog('WARN', 'writeObservation failed (non-fatal)', { error: err?.message });
        return false;
    }
}

async function main() {
    const input = readStdinJson();
    if (!input) {
        hookLog('DEBUG', 'PostToolUse: no stdin data, exit 0');
        process.exit(0);
    }

    const toolName = input.tool_name || input.tool || 'unknown';

    if (!shouldLogTool(toolName)) {
        // Silent skip for read-only tools
        process.exit(0);
    }

    try {
        const inputSummary = formatToolInput(input.tool_input || input.input);
        const responseSummary = formatToolResponse(input.tool_response || input.response || input.result);

        const raw = `${inputSummary}${responseSummary ? ' | ' + responseSummary : ''}`;
        const { text: cleaned, redactions } = cleanForLog(raw, 2500);

        const note = redactions > 0 ? ` [${redactions} redacted]` : '';
        const entry = cleaned + note;

        const target = resolveActiveTarget();
        const ok = await callAutolog({
            target,
            entry,
            event_type: 'tool_use',
            tool_name: toolName
        });

        const runbookId = target ? `RUNBOOK_${target.replace(/[^a-zA-Z0-9._-]/g, '_')}.md` : null;
        await writeObservation({
            runbook_id: runbookId,
            tool_name: toolName,
            tool_input_summary: inputSummary.substring(0, 200),
            tool_response_summary: responseSummary.substring(0, 300)
        });

        hookLog('INFO', 'PostToolUse logged', {
            tool: toolName,
            target: target || '_AUTO_LOG_UNIFIED',
            entry_len: entry.length,
            redactions,
            ok
        });
    } catch (err) {
        hookLog('ERROR', 'PostToolUse exception', { error: err?.message });
    }

    process.exit(0);
}

main().catch((err) => {
    hookLog('FATAL', 'PostToolUse fatal', { error: err?.message });
    process.exit(0);
});
