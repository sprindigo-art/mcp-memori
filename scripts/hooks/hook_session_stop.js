#!/usr/bin/env node
/**
 * Stop hook — template-based session summary (NO AI call, offline-capable).
 *
 * Reads session's _AUTO_LOG entries since last Stop, extracts:
 *  - Commands executed (top 10 unique)
 *  - Files read/modified (top 10 unique)
 *  - Errors encountered (all)
 *  - Tools used (frequency count)
 * Appends summary to ## SESSION LOG section (NOT section state).
 *
 * Unlike claude-mem's Stop hook which calls SDKAgent/Gemini/OpenRouter,
 * this runs purely on regex — no API key, no network, no dependency.
 */
import { readFileSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readStdinJson, hookLog, resolveActiveTarget } from './hook_lib.js';
import {
    RUNBOOKS_DIR, titleToFilename, findByTitle, findByFuzzyTitle,
    parseFrontmatter, findSectionEnd
} from '../../src/storage/files.js';

const LOOKBACK_HOURS = 4;

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

function extractSection(body, header) {
    const idx = body.indexOf(header);
    if (idx === -1) return { content: '', start: -1, end: -1 };
    const end = findSectionEnd(body, idx);
    return { content: body.substring(idx, end), start: idx, end };
}

/**
 * Parse _AUTO_LOG entries into structured records.
 * Entry format: "- [YYYY-MM-DD HH:MM:SS] [event_type/tool_name] payload"
 */
function parseAutologEntries(autologContent, sinceMs) {
    const lines = autologContent.split('\n');
    const entries = [];
    const lineRe = /^- \[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] \[([^/\]]+)\/([^\]]+)\] (.+)$/;
    for (const line of lines) {
        const m = line.match(lineRe);
        if (!m) continue;
        const ts = Date.parse(m[1] + 'Z');
        if (isNaN(ts)) continue;
        if (ts < sinceMs) continue;
        entries.push({ ts, event_type: m[2], tool_name: m[3], payload: m[4] });
    }
    return entries;
}

async function main() {
    const input = readStdinJson();
    const target = resolveActiveTarget();

    if (!target) {
        hookLog('INFO', 'Stop: no active target, skip');
        process.exit(0);
    }

    const filepath = findRunbookPath(target);
    if (!filepath) {
        hookLog('INFO', 'Stop: no runbook for target, skip', { target });
        process.exit(0);
    }

    try {
        const raw = readFileSync(filepath, 'utf8');
        const { body } = parseFrontmatter(raw);

        const autolog = extractSection(body, '## _AUTO_LOG');
        if (!autolog.content) {
            hookLog('INFO', 'Stop: no _AUTO_LOG, skip', { target });
            process.exit(0);
        }

        const sinceMs = Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000;
        const entries = parseAutologEntries(autolog.content, sinceMs);
        if (entries.length < 5) {
            hookLog('INFO', 'Stop: <5 entries, skip', { target, entries: entries.length });
            process.exit(0);
        }

        // NO TEMPLATE SUMMARY — only fire LLM worker for AI-compressed narrative
        // Template summaries (tool counts, command lists) were noise that caused
        // 91-duplicate SESSION LOG spam. LLM narrative is the useful part.
        if (process.env.MCP_MEMORI_LLM_SUMMARY !== '0') {
            try {
                const __dirname = dirname(fileURLToPath(import.meta.url));
                const workerPath = join(__dirname, 'hook_llm_summary_worker.js');
                const child = spawn('node', [
                    workerPath,
                    '--target', target,
                    '--filepath', filepath,
                    '--since', String(sinceMs)
                ], {
                    detached: true,
                    stdio: 'ignore',
                    env: process.env
                });
                child.unref();
                hookLog('INFO', 'Stop: LLM worker spawned', { target, entries: entries.length, pid: child.pid });
            } catch (err) {
                hookLog('WARN', 'Stop: LLM worker spawn failed', { error: err?.message });
            }
        }
    } catch (err) {
        hookLog('ERROR', 'Stop exception', { error: err?.message });
    }

    process.exit(0);
}

main().catch((err) => {
    hookLog('FATAL', 'Stop fatal', { error: err?.message });
    process.exit(0);
});
