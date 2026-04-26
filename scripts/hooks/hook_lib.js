/**
 * Shared hook helpers for mcp-memori v7.6 auto-capture layer.
 *
 * Hooks are invoked by Claude Code with stdin JSON. They must:
 * - Exit fast (<2s) to not block tool call pipeline
 * - Exit 0 on error (fail-silent, never block) — errors go to stderr log
 * - Never modify section state (CREDENTIAL/EXPLOIT/LIVE STATUS/etc)
 * - Only touch section _AUTO_LOG via memory_autolog
 *
 * Design: hooks import memory.autolog.js DIRECTLY (in-process Node call).
 * No MCP JSON-RPC handshake needed — file-based storage is independent
 * of MCP server. File locking in files.js handles concurrent writes.
 */
import { readFileSync, existsSync, statSync, readdirSync, appendFileSync, mkdirSync, fstatSync } from 'fs';
import { join, dirname } from 'path';
import { execute as autologExecute } from '../../src/mcp/tools/memory.autolog.js';
import { scrub, truncate } from '../../src/utils/scrubber.js';

const RUNBOOKS_DIR = '/home/kali/Desktop/mcp-memori/runbooks';
const HOOK_LOG = '/home/kali/Desktop/mcp-memori/data/hook_debug.log';
const AUTO_MEMORY_PATH = '/home/kali/.claude/projects/-home-kali-Desktop-mcp-memori/memory/MEMORY.md';

/**
 * Read stdin fully and parse JSON. Returns null on any failure.
 * Claude Code passes hook event data via stdin as JSON object.
 *
 * Uses SYNC read (fs.readFileSync(0)) to avoid event-loop race with
 * heavy imports (better-sqlite3 native module ~1-2s cold load).
 */
export function readStdinJson() {
    try {
        // FD 0 = stdin. Sync read works for pipe (FIFO) AND socket (Claude Code uses socket).
        // Only skip if TTY — hooks invoked interactively have no data.
        const stat = fstatSync(0);
        if (stat.isCharacterDevice()) {
            // TTY attached (interactive) — no pipe/socket data
            return null;
        }
        // For FIFO, socket, or file: attempt sync read
        const raw = readFileSync(0, 'utf8');
        if (!raw || !raw.trim()) return null;
        try { return JSON.parse(raw); } catch { return null; }
    } catch {
        return null;
    }
}

/**
 * Write to hook debug log (stderr-style, never to stdout).
 * Used for post-mortem if hook misbehaves.
 */
export function hookLog(level, message, meta = {}) {
    try {
        const dir = dirname(HOOK_LOG);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const line = `[${new Date().toISOString()}] [${level}] ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}\n`;
        appendFileSync(HOOK_LOG, line, 'utf8');
    } catch { /* fail-silent */ }
}

/**
 * Resolve currently active target runbook.
 * Strategy:
 * 1. Read MEMORY.md "TARGET AKTIF TERAKHIR" pointer (if exists).
 * 2. Fallback: most-recently-modified RUNBOOK_*.md file (excluding _AUTO_LOG_UNIFIED).
 * 3. Fallback: null → autolog will use _AUTO_LOG_UNIFIED fallback.
 */
export function resolveActiveTarget() {
    // Strategy 1: MEMORY.md pointer
    try {
        if (existsSync(AUTO_MEMORY_PATH)) {
            const content = readFileSync(AUTO_MEMORY_PATH, 'utf8');
            const m = content.match(/- Target:\s*([^\n(]+?)(?:\s*\(|$)/m);
            if (m && m[1]) {
                const target = m[1].trim();
                if (target && target.toLowerCase() !== 'none' && target.length > 2) {
                    return target;
                }
            }
        }
    } catch { /* ignore */ }

    // Strategy 2: most-recent RUNBOOK_*.md
    try {
        const files = readdirSync(RUNBOOKS_DIR)
            .filter(f => f.startsWith('RUNBOOK_') && f.endsWith('.md') && !f.includes('_AUTO_LOG_UNIFIED'))
            .map(f => ({
                file: f,
                mtime: statSync(join(RUNBOOKS_DIR, f)).mtimeMs
            }))
            .sort((a, b) => b.mtime - a.mtime);
        if (files.length > 0) {
            // Extract target from filename: RUNBOOK_example.com.md → example.com
            const top = files[0].file.replace(/^RUNBOOK_/, '').replace(/\.md$/, '');
            // Skip if recent file is stale (>7 days) — probably no active session
            const ageHours = (Date.now() - files[0].mtime) / (1000 * 60 * 60);
            if (ageHours < 24 * 7) return top;
        }
    } catch { /* ignore */ }

    return null;
}

/**
 * Call memory_autolog tool in-process.
 * Returns true on success (including dedup skip), false on failure.
 * NEVER throws — hooks must not break tool call pipeline.
 */
export async function callAutolog({ target, entry, event_type, tool_name }) {
    try {
        const result = await autologExecute({ target, entry, event_type, tool_name });
        if (!result.ok) {
            hookLog('WARN', 'autolog returned ok=false', { error: result?.meta?.error });
            return false;
        }
        return true;
    } catch (err) {
        hookLog('ERROR', 'autolog threw exception', { error: err?.message });
        return false;
    }
}

/**
 * Scrub + truncate text for safe auto-logging.
 * Returns: { text: cleaned, redactions: count }
 */
export function cleanForLog(text, maxLen = 3000) {
    if (!text) return { text: '', redactions: 0 };
    const truncated = truncate(String(text), maxLen);
    return scrub(truncated);
}

/**
 * Tools that generate noise or irrelevant output for auto-log.
 * Read-only tools already captured in Claude's context; logging them wastes space.
 */
const SKIP_TOOLS = new Set([
    'Read', 'Glob', 'Grep', 'TodoWrite', 'Skill', 'ToolSearch',
    'NotebookRead', 'ExitPlanMode'
]);

/**
 * Check if this tool call should be auto-logged.
 * Bash/Edit/Write/WebFetch/WebSearch/MCP tools = YES (side effects).
 * Read/Grep/Glob = NO (read-only, noise).
 */
export function shouldLogTool(toolName) {
    if (!toolName) return false;
    if (SKIP_TOOLS.has(toolName)) return false;
    return true;
}

/**
 * Format tool_input for log (single line, compact).
 * Extracts most relevant field (command/file_path/url/pattern).
 */
export function formatToolInput(toolInput) {
    if (!toolInput || typeof toolInput !== 'object') return '';
    // Bash → command
    if (toolInput.command) return `cmd: ${String(toolInput.command).substring(0, 500)}`;
    // Edit/Write → file_path
    if (toolInput.file_path) {
        const summary = [`file: ${toolInput.file_path}`];
        if (toolInput.old_string) summary.push(`old_len=${String(toolInput.old_string).length}`);
        if (toolInput.new_string) summary.push(`new_len=${String(toolInput.new_string).length}`);
        if (toolInput.content) summary.push(`content_len=${String(toolInput.content).length}`);
        return summary.join(' | ');
    }
    // WebFetch → url
    if (toolInput.url) return `url: ${toolInput.url}` + (toolInput.prompt ? ` | prompt_len=${String(toolInput.prompt).length}` : '');
    // WebSearch → query
    if (toolInput.query) return `query: ${toolInput.query}`;
    // MCP tool → serialize keys
    const keys = Object.keys(toolInput);
    if (keys.length === 0) return '';
    const compact = keys.slice(0, 3).map(k => {
        const v = toolInput[k];
        if (v === null || v === undefined) return `${k}=null`;
        if (typeof v === 'string') return `${k}="${v.substring(0, 80)}"`;
        if (typeof v === 'number' || typeof v === 'boolean') return `${k}=${v}`;
        if (Array.isArray(v)) return `${k}=[${v.length}]`;
        return `${k}=<obj>`;
    }).join(' ');
    return compact;
}

/**
 * Format tool_response for log. Extract essential outcome signals.
 * IMPORTANT: Edit/Write tool_response echoes full oldString/newString — skip
 * that to avoid bloating _AUTO_LOG with diff content that's already captured
 * in tool_input formatting (old_len/new_len counts).
 */
export function formatToolResponse(toolResponse) {
    if (!toolResponse) return '';
    if (typeof toolResponse === 'string') return toolResponse.substring(0, 500);

    // Error detection FIRST (highest signal value)
    if (toolResponse.error || toolResponse.isError) {
        const errText = String(toolResponse.error || toolResponse.content?.[0]?.text || 'unknown');
        return `ERROR: ${errText.substring(0, 300)}`;
    }

    // Bash: stdout + stderr summary
    if (toolResponse.stdout !== undefined || toolResponse.stderr !== undefined) {
        const out = String(toolResponse.stdout || '').trim();
        const err = String(toolResponse.stderr || '').trim();
        const parts = [];
        if (out) parts.push(`stdout: ${out.substring(0, 400)}`);
        if (err) parts.push(`stderr: ${err.substring(0, 200)}`);
        return parts.join(' | ') || '<empty>';
    }

    // Edit/Write: response echoes oldString/newString — don't dump those (noise)
    // Just signal success if structuredPatch or filePath present
    if (toolResponse.filePath || toolResponse.structuredPatch || toolResponse.originalFile !== undefined) {
        return 'ok: edited';
    }

    // MCP tool response: extract text content but cap hard
    if (toolResponse.content && Array.isArray(toolResponse.content)) {
        const text = toolResponse.content.map(c => c.text || '').join(' ').substring(0, 400);
        return `out: ${text}`;
    }

    // Last resort: compact JSON
    try {
        const compact = JSON.stringify(toolResponse);
        if (compact.length > 400) return `json(${compact.length}b): ${compact.substring(0, 300)}`;
        return `json: ${compact}`;
    } catch {
        return '<unreadable>';
    }
}

export default {
    readStdinJson,
    hookLog,
    resolveActiveTarget,
    callAutolog,
    cleanForLog,
    shouldLogTool,
    formatToolInput,
    formatToolResponse
};
