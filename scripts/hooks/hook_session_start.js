#!/usr/bin/env node
/**
 * SessionStart hook — inject concise state of active target into new session.
 *
 * CONTRACT (Claude Code hook):
 * - Input: stdin JSON { source: "startup"|"resume"|"clear"|"compact", ... }
 * - Output: stdout JSON { hookSpecificOutput: { hookEventName: "SessionStart",
 *                        additionalContext: "..." } }
 * - Exit 0 always
 *
 * Strategy: load LIVE STATUS + RE-ENTRY CHECKLIST + last 10 entries of _AUTO_LOG
 * from active target. Max 2500 chars. Tidak panggil AI — pure file read.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { readStdinJson, hookLog, resolveActiveTarget } from './hook_lib.js';
import {
    RUNBOOKS_DIR, titleToFilename, findByTitle, findByFuzzyTitle,
    parseFrontmatter, findSectionEnd, isMajorSection
} from '../../src/storage/files.js';

const MAX_CONTEXT_CHARS = 2500;

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

function extractSection(body, sectionName) {
    const header = `## ${sectionName}`;
    // Must match at START OF LINE (not inside _CHANGELOG text like "replaced ## LIVE STATUS")
    const regex = new RegExp(`^${header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'im');
    const match = regex.exec(body);
    if (!match) return '';
    // Verify it's a real section header (preceded by newline or start of string)
    const idx = match.index;
    if (idx > 0 && body[idx - 1] !== '\n') return '';
    const end = findSectionEnd(body, idx);
    return body.substring(idx, end).trim();
}

function lastNLines(text, n = 10) {
    const lines = text.split('\n').filter(l => l.trim());
    return lines.slice(-n).join('\n');
}

async function main() {
    const input = readStdinJson();
    const source = input?.source || 'unknown';

    const target = resolveActiveTarget();
    if (!target) {
        // No active target — output empty context, don't inject noise
        process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
                hookEventName: 'SessionStart',
                additionalContext: ''
            }
        }));
        hookLog('INFO', 'SessionStart: no active target', { source });
        process.exit(0);
    }

    const filepath = findRunbookPath(target);
    if (!filepath) {
        process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
                hookEventName: 'SessionStart',
                additionalContext: ''
            }
        }));
        hookLog('INFO', 'SessionStart: no runbook for target', { source, target });
        process.exit(0);
    }

    try {
        const raw = readFileSync(filepath, 'utf8');
        const { meta, body } = parseFrontmatter(raw);

        const liveStatus = extractSection(body, 'LIVE STATUS');
        const reEntry = extractSection(body, 'RE-ENTRY CHECKLIST');
        const autoLog = extractSection(body, '_AUTO_LOG');
        const autoLogTail = autoLog ? lastNLines(autoLog, 10) : '';

        const parts = [];
        parts.push(`# mcp-memori: Active Target Context`);
        parts.push(`**Target:** ${meta.title || target}`);
        parts.push(`**Updated:** ${meta.updated || 'unknown'} | **Version:** v${meta.version || 1}`);
        parts.push(`**Source:** ${source} (SessionStart hook)`);
        parts.push('');

        if (liveStatus) {
            parts.push(liveStatus.substring(0, 800));
            parts.push('');
        }
        if (reEntry) {
            parts.push(reEntry.substring(0, 800));
            parts.push('');
        }
        if (autoLogTail) {
            parts.push(`## Recent Auto-Log (last 10 entries)\n${autoLogTail.substring(0, 600)}`);
        }

        parts.push('');
        parts.push(`> Gunakan \`memory_get({id:"${filepath.split('/').pop()}"})\` untuk full runbook.`);
        parts.push(`> SECTION STATE tetap hard-block: wajib \`memory_get\` sebelum \`memory_upsert\` ke CREDENTIAL/EXPLOIT/GAGAL/LIVE STATUS/RE-ENTRY CHECKLIST.`);

        let context = parts.join('\n');
        if (context.length > MAX_CONTEXT_CHARS) {
            context = context.substring(0, MAX_CONTEXT_CHARS) + '\n\n[...context truncated, use memory_get for full runbook]';
        }

        process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
                hookEventName: 'SessionStart',
                additionalContext: context
            }
        }));

        hookLog('INFO', 'SessionStart context injected', {
            source,
            target,
            context_len: context.length,
            has_live_status: !!liveStatus,
            has_re_entry: !!reEntry,
            autolog_entries: autoLogTail ? autoLogTail.split('\n').length : 0
        });
    } catch (err) {
        hookLog('ERROR', 'SessionStart exception', { error: err?.message });
        process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
                hookEventName: 'SessionStart',
                additionalContext: ''
            }
        }));
    }

    process.exit(0);
}

main().catch((err) => {
    hookLog('FATAL', 'SessionStart fatal', { error: err?.message });
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: ''
        }
    }));
    process.exit(0);
});
