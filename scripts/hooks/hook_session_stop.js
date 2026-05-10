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
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readStdinJson, hookLog, resolveActiveTarget, clearSessionTarget } from './hook_lib.js';
import {
    RUNBOOKS_DIR, titleToFilename, findByTitle, findByFuzzyTitle,
    parseFrontmatter, findSectionEnd, acquireLock, releaseLock, atomicWriteFileSync, buildFrontmatter
} from '../../src/storage/files.js';

const LOOKBACK_HOURS = 4;
const SESSION_LOG_MAX_SIZE = 50 * 1024; // 50KB → rotate
const SESSION_LOG_KEEP_SESSIONS = 10;   // keep last 10 sessions
const ARCHIVE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'archives');

function rotateSessionLog(existingLog, runbookFilename) {
    const sessions = existingLog.split(/(?=^### Session )/m);
    const header = sessions[0]; // "## SESSION LOG\n"
    const entries = sessions.slice(1);
    if (entries.length <= SESSION_LOG_KEEP_SESSIONS) return { log: existingLog, rotated: false };
    const keep = entries.slice(-SESSION_LOG_KEEP_SESSIONS);
    const archive = entries.slice(0, -SESSION_LOG_KEEP_SESSIONS);
    try {
        mkdirSync(ARCHIVE_DIR, { recursive: true });
        const date = new Date().toISOString().split('T')[0];
        const baseName = (runbookFilename || 'unknown').replace(/\.md$/, '');
        const archivePath = join(ARCHIVE_DIR, `${baseName}_sessionlog_${date}.log`);
        appendFileSync(archivePath, archive.join(''), 'utf8');
        hookLog('INFO', 'SessionLog rotated', { archived: archive.length, kept: keep.length, path: archivePath });
    } catch (err) {
        hookLog('WARN', 'SessionLog archive failed', { error: err?.message });
    }
    const marker = `[${new Date().toISOString().split('T')[0]}] SESSION LOG rotated, ${archive.length} older sessions archived\n\n`;
    // Strip old rotation markers from header to prevent accumulation
    const cleanHeader = header.replace(/\[[\d-]+\] SESSION LOG rotated.*\n\n?/g, '');
    return { log: cleanHeader + marker + keep.join(''), rotated: true };
}

function findRunbookPath(target) {
    if (!target) return null;
    const title = target.startsWith('[') ? target : `[RUNBOOK] ${target}`;
    const filename = titleToFilename(title);
    let filepath = join(RUNBOOKS_DIR, filename);
    if (existsSync(filepath)) return filepath;
    const byTitle = findByTitle(title);
    if (byTitle) return byTitle;
    return findByFuzzyTitle(title);
}

function extractSection(body, header) {
    const regex = new RegExp(`^${header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'im');
    const match = regex.exec(body);
    if (!match) return { content: '', start: -1, end: -1 };
    const idx = match.index;
    if (idx > 0 && body[idx - 1] !== '\n') return { content: '', start: -1, end: -1 };
    const end = findSectionEnd(body, idx);
    return { content: body.substring(idx, end), start: idx, end };
}

function parseAutologEntries(autologContent, sinceMs) {
    const lines = autologContent.split('\n');
    const entries = [];
    const lineRe = /^- \[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] \[([^/\]]+)\/([^\]]+)\] (.+)$/;
    for (const line of lines) {
        const m = line.match(lineRe);
        if (!m) continue;
        const ts = Date.parse(m[1] + 'Z');
        if (isNaN(ts) || ts < sinceMs) continue;
        entries.push({ ts, event_type: m[2], tool_name: m[3], payload: m[4] });
    }
    return entries;
}

/**
 * v8.0: Template-based session summary — NO AI, pure regex extraction.
 * Extracts from _AUTO_LOG: commands, files, errors, tools, key findings.
 * Appends to ## SESSION LOG as structured summary (like claude-mem but offline).
 */
function buildTemplateSummary(entries) {
    const commands = new Map();
    const files = new Set();
    const errors = [];
    const toolCounts = new Map();
    const keyFindings = [];

    for (const e of entries) {
        const tool = e.tool_name || 'unknown';
        toolCounts.set(tool, (toolCounts.get(tool) || 0) + 1);

        const p = e.payload || '';

        if (tool === 'Bash' || tool === 'bash') {
            const cmdMatch = p.match(/^cmd:\s*(.+?)(?:\s*\||\s*$)/);
            if (cmdMatch) {
                const cmd = cmdMatch[1].substring(0, 120);
                commands.set(cmd, (commands.get(cmd) || 0) + 1);
            }
        }

        if (/file:|path:/i.test(p)) {
            const fileMatch = p.match(/(?:file|path):\s*([^\s|,]+)/i);
            if (fileMatch) files.add(fileMatch[1].substring(0, 100));
        }

        if (/ERROR|FAIL|DENIED|BLOCKED|TIMEOUT|refused|denied/i.test(p)) {
            errors.push(p.substring(0, 150));
        }

        if (/credential|password|root|shell|webshell|reverse|exploit|berhasil|success|rce|access gained/i.test(p)) {
            keyFindings.push(`[${e.tool_name}] ${p.substring(0, 120)}`);
        }
    }

    const lines = [];
    const now = new Date().toISOString().substring(0, 19).replace('T', ' ');
    lines.push(`### Session ${now} (${entries.length} actions)`);

    if (toolCounts.size > 0) {
        const sorted = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]);
        lines.push(`**Tools:** ${sorted.map(([t, c]) => `${t}(${c})`).join(', ')}`);
    }

    if (commands.size > 0) {
        lines.push(`**Commands (top 10):**`);
        const topCmds = [...commands.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
        for (const [cmd, count] of topCmds) {
            lines.push(`- \`${cmd}\`${count > 1 ? ` (×${count})` : ''}`);
        }
    }

    if (files.size > 0) {
        lines.push(`**Files (${files.size}):** ${[...files].slice(0, 10).join(', ')}${files.size > 10 ? ` +${files.size - 10} more` : ''}`);
    }

    if (errors.length > 0) {
        lines.push(`**Errors (${errors.length}):**`);
        for (const err of errors.slice(0, 5)) {
            lines.push(`- ${err}`);
        }
    }

    if (keyFindings.length > 0) {
        lines.push(`**Key findings:**`);
        for (const f of keyFindings.slice(0, 5)) {
            lines.push(`- ${f}`);
        }
    }

    return lines.join('\n');
}

async function main() {
    const input = readStdinJson();
    const sessionId = input?.session_id || null;
    const target = resolveActiveTarget(sessionId);

    if (!target) {
        hookLog('INFO', 'Stop: no active target, skip');
        process.exit(0);
    }

    const filepath = findRunbookPath(target);
    if (!filepath) {
        hookLog('INFO', 'Stop: no runbook file for target', { target });
        process.exit(0);
    }

    try {
        // Lock BEFORE read to prevent TOCTOU (PostToolUse can modify between read and write)
        acquireLock(filepath);
        try {
            const raw = readFileSync(filepath, 'utf8');
            const { meta, body } = parseFrontmatter(raw);
            const autolog = extractSection(body, '## _AUTO_LOG');

            if (!autolog.content) {
                hookLog('INFO', 'Stop: no _AUTO_LOG section', { target });
                releaseLock(filepath);
                process.exit(0);
            }

            const sinceMs = Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000;
            const entries = parseAutologEntries(autolog.content, sinceMs);

            if (entries.length < 3) {
                hookLog('INFO', 'Stop: too few entries for summary', { target, entries: entries.length });
                releaseLock(filepath);
                process.exit(0);
            }

            const summary = buildTemplateSummary(entries);
            const sessionLogHeader = '## SESSION LOG';
            let newBody;

            if (body.includes(sessionLogHeader)) {
                const slIdx = body.indexOf(sessionLogHeader);
                const slEnd = findSectionEnd(body, slIdx);
                let existingLog = body.substring(slIdx, slEnd);
                if (existingLog.length > SESSION_LOG_MAX_SIZE) {
                    const fn = filepath ? filepath.split('/').pop() : target;
                    const { log: rotatedLog } = rotateSessionLog(existingLog, fn);
                    existingLog = rotatedLog;
                }
                // Strip accumulated rotation markers (keep none — new rotation adds fresh one)
                existingLog = existingLog.replace(/\[[\d-]+\] SESSION LOG rotated[^\n]*\n\n?/g, '');
                newBody = body.substring(0, slIdx) + existingLog.trimEnd() + '\n\n' + summary + '\n\n' + body.substring(slEnd);
            } else {
                const autoLogIdx = body.indexOf('## _AUTO_LOG');
                if (autoLogIdx > 0) {
                    newBody = body.substring(0, autoLogIdx).trimEnd() + '\n\n' + sessionLogHeader + '\n' + summary + '\n\n' + body.substring(autoLogIdx);
                } else {
                    newBody = body.trimEnd() + '\n\n' + sessionLogHeader + '\n' + summary + '\n';
                }
            }

            meta.updated = new Date().toISOString();
            const finalContent = buildFrontmatter(meta) + newBody.trim() + '\n';
            atomicWriteFileSync(filepath, finalContent, 'utf8');

            hookLog('INFO', 'Stop: session summary written', { target, entries: entries.length, summary_len: summary.length });
        } finally {
            releaseLock(filepath);
        }
    } catch (err) {
        hookLog('WARN', 'Stop: summary error', { error: err?.message });
    }

    // LLM summary (opt-in, disabled by default)
    if (process.env.MCP_MEMORI_LLM_SUMMARY === '1') {
        try {
            const raw = readFileSync(filepath, 'utf8');
            const { body } = parseFrontmatter(raw);
            const autolog = extractSection(body, '## _AUTO_LOG');
            if (autolog.content) {
                const sinceMs = Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000;
                const entries = parseAutologEntries(autolog.content, sinceMs);
                if (entries.length >= 10) {
                    const __dirname = dirname(fileURLToPath(import.meta.url));
                    const workerPath = join(__dirname, 'hook_llm_summary_worker.js');
                    const child = spawn('node', [workerPath, '--target', target, '--filepath', filepath, '--since', String(sinceMs)], { detached: true, stdio: 'ignore', env: process.env });
                    child.unref();
                    hookLog('INFO', 'Stop: LLM worker spawned (opt-in)', { target, entries: entries.length, pid: child.pid });
                }
            }
        } catch (err) {
            hookLog('WARN', 'Stop: LLM error', { error: err?.message });
        }
    }

    // Cleanup per-session temp files
    if (sessionId) {
        clearSessionTarget(sessionId);
        try {
            const cp = `/tmp/mcp-memori-counter-${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 100)}`;
            const { existsSync: ex2, unlinkSync: ul2 } = await import('fs');
            if (ex2(cp)) ul2(cp);
        } catch {}
    }

    process.exit(0);
}

main().catch((err) => {
    hookLog('FATAL', 'Stop fatal', { error: err?.message });
    process.exit(0);
});
