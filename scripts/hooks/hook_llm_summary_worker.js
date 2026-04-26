#!/usr/bin/env node
/**
 * LLM Summary Worker — fire-and-forget subprocess spawned by hook_session_stop.
 *
 * Calls local `claude -p "..."` CLI (authenticated via Claude Code) to compress
 * raw _AUTO_LOG entries into a 3-5 sentence semantic narrative. Parent Stop hook
 * exits in <100ms; this worker runs detached in background.
 *
 * Writes output as `### [LLM] Session <ts>` entry inside the existing
 * ## SESSION LOG section of the target runbook, under a file lock to avoid
 * racing with the parent's template summary write.
 *
 * Never throws to stdout/stderr. Fail-silent. Errors go to hook_debug.log.
 *
 * Args: --target <name> --filepath <path> --since <ms>
 * Env:
 *   MCP_MEMORI_LLM_SUMMARY=0       disable entirely
 *   MCP_MEMORI_LLM_TIMEOUT=45000   override CLI timeout (ms)
 *   MCP_MEMORI_LLM_MIN_ENTRIES=3   skip if fewer entries in window
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, renameSync, appendFileSync, mkdirSync } from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
    parseFrontmatter, buildFrontmatter, findSectionEnd,
    acquireLock, releaseLock
} from '../../src/storage/files.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HOOK_LOG = join(__dirname, '..', '..', 'data', 'hook_debug.log');

function log(level, message, meta = {}) {
    try {
        const line = `[${new Date().toISOString()}] [${level}] LLM_WORKER ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}\n`;
        try { mkdirSync(dirname(HOOK_LOG), { recursive: true }); } catch {}
        appendFileSync(HOOK_LOG, line, 'utf8');
    } catch { /* fail-silent */ }
}

function parseArgs() {
    const out = {};
    const a = process.argv.slice(2);
    for (let i = 0; i < a.length; i += 2) {
        const k = a[i]?.replace(/^--/, '');
        const v = a[i + 1];
        if (k) out[k] = v;
    }
    return out;
}

function parseAutologEntries(body, sinceMs) {
    const idx = body.indexOf('## _AUTO_LOG');
    if (idx === -1) return [];
    const end = findSectionEnd(body, idx);
    const content = body.substring(idx, end);
    const lines = content.split('\n');
    const re = /^- \[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] \[([^/\]]+)\/([^\]]+)\] (.+)$/;
    const out = [];
    for (const line of lines) {
        const m = line.match(re);
        if (!m) continue;
        const ts = Date.parse(m[1] + 'Z');
        if (isNaN(ts) || ts < sinceMs) continue;
        out.push({ ts: m[1], event: m[2], tool: m[3], payload: m[4] });
    }
    return out;
}

function callClaude(prompt, timeoutMs) {
    return new Promise((resolve) => {
        let stdout = '', stderr = '', done = false;
        const child = spawn('claude', ['-p', prompt, '--output-format', 'text'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '0' }
        });
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            try { child.kill('SIGKILL'); } catch {}
            resolve({ ok: false, error: 'timeout' });
        }, timeoutMs);
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', (err) => {
            if (done) return; done = true; clearTimeout(timer);
            resolve({ ok: false, error: err.message });
        });
        child.on('close', (code) => {
            if (done) return; done = true; clearTimeout(timer);
            if (code !== 0) return resolve({ ok: false, error: `exit ${code}: ${stderr.substring(0, 200)}` });
            resolve({ ok: true, output: stdout.trim() });
        });
    });
}

function buildPrompt(target, entries) {
    const header = `Compress the following raw tool-use log from a red-team/engineering session into a SINGLE semantic paragraph (3-5 sentences max). Capture: (1) what the operator worked on, (2) key files/systems/endpoints touched, (3) notable errors or breakthroughs, (4) likely next step. Be concise, factual, PLAIN PROSE ONLY — DO NOT use any markdown heading markers (no #, ##, ###, ####), no bullet lists, no code fences, no preface. If you need to mention a section name, wrap it in backticks. Output ONLY the paragraph.`;
    const lines = entries.map(e => `[${e.ts}] ${e.tool}: ${e.payload}`).join('\n').substring(0, 6000);
    return `${header}\n\nTarget: ${target}\nEntries (${entries.length}):\n${lines}\n\nSemantic summary:`;
}

/**
 * Defense-in-depth against LLM accidentally emitting markdown headings.
 * Any line beginning with `#` gets 2 leading spaces prepended so section
 * parsers in files.js (isMajorSection, findSectionEnd) no longer match it.
 * Preserves all characters — zero content loss.
 */
function sanitizeLlmOutput(text) {
    return String(text).replace(/^(#{1,6} )/gm, '  $1');
}

function appendLlmSummaryToActivityLog(filepath, summaryText, entryCount) {
    const raw = readFileSync(filepath, 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    const ACTIVITY_HEADER = '## ACTIVITY SUMMARY';
    const now = new Date().toISOString().substring(0, 19).replace('T', ' ');
    const llmBlock = `### [${now}] (${entryCount} actions)\n${summaryText.trim()}\n`;

    // Anti-duplicate: if last ACTIVITY SUMMARY entry was <15 min ago, skip
    const idx = body.indexOf(ACTIVITY_HEADER);
    if (idx >= 0) {
        const sectionEnd = findSectionEnd(body, idx);
        const sectionBlock = body.substring(idx, sectionEnd);
        const lastEntry = sectionBlock.match(/### \[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/);
        if (lastEntry) {
            const lastMs = Date.parse(lastEntry[1].replace(' ', 'T') + 'Z');
            if (!isNaN(lastMs) && Date.now() - lastMs < 15 * 60 * 1000) {
                log('INFO', 'recent activity summary exists, skip', { age_sec: Math.round((Date.now() - lastMs) / 1000) });
                return;
            }
        }
        // Max 5 entries — remove oldest if exceeding
        const entryCount2 = (sectionBlock.match(/### \[/g) || []).length;
        if (entryCount2 >= 5) {
            const lines = sectionBlock.split('\n');
            let kept = [], count = 0;
            for (const line of lines) {
                if (line.startsWith('### [')) count++;
                if (count <= 4) kept.push(line);
            }
            const trimmedSection = kept.join('\n');
            const newBody2 = body.substring(0, idx) + trimmedSection.trimEnd() + '\n' + llmBlock + '\n' + body.substring(sectionEnd);
            meta.updated = new Date().toISOString();
            const finalContent = buildFrontmatter(meta) + newBody2.trim() + '\n';
            const tmp = filepath + '.tmp';
            const bak = filepath + '.bak';
            if (existsSync(filepath)) { try { copyFileSync(filepath, bak); } catch {} }
            writeFileSync(tmp, finalContent, 'utf8');
            renameSync(tmp, filepath);
            return;
        }
    }

    let newBody;
    if (idx === -1) {
        // Insert ACTIVITY SUMMARY before _AUTO_LOG or _CHANGELOG
        const autoLogIdx = body.indexOf('## _AUTO_LOG');
        const changelogIdx = body.indexOf('## _CHANGELOG');
        const insertBefore = changelogIdx > 0 ? changelogIdx : (autoLogIdx > 0 ? autoLogIdx : -1);
        if (insertBefore > 0) {
            newBody = body.substring(0, insertBefore).trimEnd() + `\n\n${ACTIVITY_HEADER}\n${llmBlock}\n\n` + body.substring(insertBefore);
        } else {
            newBody = body.trimEnd() + `\n\n${ACTIVITY_HEADER}\n${llmBlock}\n`;
        }
    } else {
        const headerEnd = body.indexOf('\n', idx) + 1;
        newBody = body.substring(0, headerEnd) + llmBlock + '\n' + body.substring(headerEnd);
    }

    meta.updated = new Date().toISOString();
    const finalContent = buildFrontmatter(meta) + newBody.trim() + '\n';
    // Inline atomic write under existing lock
    const tmp = filepath + '.tmp';
    const bak = filepath + '.bak';
    if (existsSync(filepath)) { try { copyFileSync(filepath, bak); } catch {} }
    writeFileSync(tmp, finalContent, 'utf8');
    renameSync(tmp, filepath);
}

async function main() {
    if (process.env.MCP_MEMORI_LLM_SUMMARY === '0') {
        log('INFO', 'disabled via env', {});
        process.exit(0);
    }
    const args = parseArgs();
    const { target, filepath, since } = args;
    if (!target || !filepath || !since) {
        log('WARN', 'missing args', { argv: process.argv.slice(2) });
        process.exit(0);
    }
    if (!existsSync(filepath)) {
        log('WARN', 'filepath not found', { filepath });
        process.exit(0);
    }

    const sinceMs = parseInt(since, 10);
    const minEntries = parseInt(process.env.MCP_MEMORI_LLM_MIN_ENTRIES || '3', 10);
    const timeoutMs = parseInt(process.env.MCP_MEMORI_LLM_TIMEOUT || '45000', 10);

    let lockHeld = false;
    try {
        const raw = readFileSync(filepath, 'utf8');
        const { body } = parseFrontmatter(raw);
        const entries = parseAutologEntries(body, sinceMs);
        if (entries.length < minEntries) {
            log('INFO', 'below min_entries, skip', { target, entries: entries.length, min: minEntries });
            process.exit(0);
        }

        // Anti-duplicate: if last SESSION LOG [LLM] entry was <10 min ago, skip
        const sessionIdx = body.indexOf('## SESSION LOG');
        if (sessionIdx >= 0) {
            const sessionEnd = findSectionEnd(body, sessionIdx);
            const sessionBlock = body.substring(sessionIdx, sessionEnd);
            const lastLlm = sessionBlock.match(/### \[LLM\] (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
            if (lastLlm) {
                const lastMs = Date.parse(lastLlm[1].replace(' ', 'T') + 'Z');
                if (!isNaN(lastMs) && Date.now() - lastMs < 10 * 60 * 1000) {
                    log('INFO', 'recent LLM summary exists, skip', { target, age_sec: Math.round((Date.now() - lastMs) / 1000) });
                    process.exit(0);
                }
            }
        }

        const prompt = buildPrompt(target, entries);
        log('INFO', 'calling claude CLI', { target, entries: entries.length, prompt_len: prompt.length, timeout_ms: timeoutMs });
        const t0 = Date.now();
        const result = await callClaude(prompt, timeoutMs);
        const latencyMs = Date.now() - t0;

        if (!result.ok) {
            log('WARN', 'claude call failed', { target, error: result.error, latency_ms: latencyMs });
            process.exit(0);
        }
        if (!result.output || result.output.length < 20) {
            log('WARN', 'claude output too short', { target, len: result.output?.length, latency_ms: latencyMs });
            process.exit(0);
        }

        acquireLock(filepath);
        lockHeld = true;
        const sanitized = sanitizeLlmOutput(result.output);
        appendLlmSummaryToActivityLog(filepath, sanitized, entries.length);
        log('INFO', 'LLM summary appended', {
            target, latency_ms: latencyMs, summary_len: result.output.length, entries: entries.length
        });
    } catch (err) {
        log('ERROR', 'worker exception', { error: err?.message });
    } finally {
        if (lockHeld) { try { releaseLock(filepath); } catch {} }
    }
    process.exit(0);
}

main().catch((err) => {
    log('FATAL', 'worker fatal', { error: err?.message });
    process.exit(0);
});
