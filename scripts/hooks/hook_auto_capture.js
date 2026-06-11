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
 * - Strips SSH key blocks only (passwords/credentials preserved for AI continuity)
 * - Truncates to 3KB max per entry
 * - Dedup last 5 entries (anti-repeat spam)
 */
import {
    readStdinJson, hookLog, resolveActiveTarget, callAutolog,
    cleanForLog, shouldLogTool, formatToolInput, formatToolResponse,
    setSessionTarget, getSessionTarget, extractTargetFromToolCall
} from './hook_lib.js';
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';

const OBS_DB_PATH = '/home/kali/Desktop/mcp-memori/data/search_index.db';
const COUNTER_PATH = '/home/kali/Desktop/mcp-memori/data/.writeback_counter';

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
        try {
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
                ).run(runbook_id || null, (tool_name || 'unknown').substring(0, 100),
                    (tool_input_summary || '').substring(0, 200), (tool_response_summary || '').substring(0, 300), contentHash);
            }
            return true;
        } finally { try { obsDb.close(); } catch {} }
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
    const sessionId = input.session_id || null;

    if (!shouldLogTool(toolName)) {
        // Silent skip for read-only tools
        process.exit(0);
    }

    try {
        const inputSummary = formatToolInput(input.tool_input || input.input);
        const responseSummary = formatToolResponse(input.tool_response || input.response || input.result);

        const raw = `${inputSummary}${responseSummary ? ' | ' + responseSummary : ''}`;
        const { text: cleaned, redactions } = cleanForLog(raw, 2500);

        const _outcomeLower = (responseSummary || '').toLowerCase();
        const outcomeTag = /root@|uid=0|shell obtained|rce confirm|admin share|success.*exploit/i.test(_outcomeLower) ? 'ACCESS'
            : /password|passwd|sshpass|credential|api[_-]?key|token[:\s=]|secret[:\s=]|\.env\b/i.test(_outcomeLower) ? 'FOUND'
            : /200 ok|completed success|berhasil|success|uploaded|created|started/i.test(_outcomeLower) ? 'SUCCESS'
            : /failed|denied|refused|timeout|blocked|403|404|500|error:|gagal|patched|unreachable/i.test(_outcomeLower) ? 'FAIL'
            : '';
        const tagPrefix = outcomeTag ? `[${outcomeTag}] ` : '';

        const note = redactions > 0 ? ` [${redactions} redacted]` : '';
        const entry = tagPrefix + cleaned + note;

        // v8.9.6: Target switch on FOCUS intent only (full RUNBOOK read or upsert)
        // extractTargetFromToolCall already returns null for reference reads (section, TEKNIK, search)
        const detectedTarget = extractTargetFromToolCall(toolName, input.tool_input || input.input);
        let targetSwitchWarning = null;
        if (detectedTarget && sessionId) {
            const existing = getSessionTarget(sessionId);
            if (detectedTarget !== existing && existing) {
                targetSwitchWarning = `⚠️ TARGET SWITCH: ${existing} → ${detectedTarget}. RULES (CLAUDE.md line 160): SEBELUM pindah target WAJIB: (1) Writeback SEMUA data target "${existing}" yang belum disimpan, (2) Update LIVE STATUS target "${existing}". Jika belum writeback → memory_upsert SEKARANG sebelum lanjut ke target baru.`;
                setSessionTarget(sessionId, detectedTarget);
                hookLog('INFO', 'Target switched (focus intent)', { from: existing, to: detectedTarget });
            } else if (!existing) {
                setSessionTarget(sessionId, detectedTarget);
                hookLog('INFO', 'Target set (first focus)', { target: detectedTarget });
            }
        }

        const target = resolveActiveTarget(sessionId);

        // v8.3: Skip logging to target runbook if tool call is clearly about
        // MCP memori codebase itself (editing src/, scripts/, mcp.config.json)
        // These pollute active target's _AUTO_LOG with unrelated development work
        const inputStr = inputSummary.toLowerCase();
        const isMcpDev = /mcp-memori\/src\/|mcp-memori\/scripts\/|mcp\.config\.json|hook_.*\.js|memory\.search|memory\.timeline|vectorIndex|searchIndex|graphIndex/.test(inputStr);
        const isGitClone = /git\s+clone|claude-mem/.test(inputStr);
        // v8.5: Filter subagent task files + Claude internal temp files → UNIFIED
        const isInternalFile = /\/tmp\/claude-[^/]*\/.*\/tasks\/|\.claude\/projects\/[^/]*\/tool-results\//.test(inputStr);
        const logTarget = (isMcpDev || isGitClone || isInternalFile) ? null : target;

        const ok = await callAutolog({
            target: logTarget,
            entry,
            event_type: 'tool_use',
            tool_name: toolName
        });

        const runbookId = logTarget ? `RUNBOOK_${logTarget.replace(/[^a-zA-Z0-9._-]/g, '_')}.md` : null;
        await writeObservation({
            runbook_id: runbookId,
            tool_name: toolName,
            tool_input_summary: inputSummary.substring(0, 200),
            tool_response_summary: responseSummary.substring(0, 300)
        });

        // v8.8: Smart writeback — warn ONLY on meaningful data, not tool call count
        // Detect: credential, shell/RCE, exploit success/fail, privesc, persistence, vuln confirmed
        const isWriteback = toolName.includes('memory_upsert');
        const counterPath = sessionId ? `/tmp/mcp-memori-counter-${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 100)}` : COUNTER_PATH;
        let counter = 0;
        try { counter = parseInt(readFileSync(counterPath, 'utf8')) || 0; } catch {}

        // Only count ACTION tools (Bash), not research/read/prep tools
        const isActionTool = /^Bash$/i.test(toolName);
        const isResearchTool = /jina|exa|tavily|cve-intel|memory_get|memory_search|memory_verify|memory_list|memory_stats|memory_timeline/i.test(toolName);
        counter = isWriteback ? 0 : (isResearchTool ? counter : counter + 1);
        try { writeFileSync(counterPath, String(counter)); } catch {}

        // Detect meaningful data in response that MUST be saved
        const respLower = (responseSummary || '').toLowerCase();
        const hasMeaningfulData = /password[:\s]|passwd[:\s]|credential|root@|uid=0|www-data|reverse.?shell|connect.?back|shell.?gained|rce.?confirm|success.*exploit|exploit.*success|gagal|failed|blocked|patched|permission.?denied|access.?denied|upload.?success|webshell|persistence|privilege.?escalat|root.?access|superuser|\.env|api.?key|token[:\s]|secret[:\s]|open.?port|port\s+\d+.*open|service.?detect|version[:\s]|apache|nginx|mysql|openssh|endpoint|subnet|alive|host.?found|discover/i.test(respLower);

        const isMemoryReadTool = /^(mcp__mcp-memori__)?(memory_search|memory_get|memory_list|memory_stats|memory_verify|memory_timeline)$/i.test(toolName);

        if (targetSwitchWarning) {
            process.stdout.write(JSON.stringify({
                hookSpecificOutput: {
                    hookEventName: 'PostToolUse',
                    additionalContext: targetSwitchWarning
                }
            }));
        } else if (hasMeaningfulData && counter > 0 && !isMemoryReadTool) {
            // Meaningful data detected — warn immediately
            const dataType = respLower.includes('password') || respLower.includes('credential') || respLower.includes('.env') ? 'CREDENTIAL'
                : respLower.includes('root@') || respLower.includes('uid=0') || respLower.includes('superuser') ? 'PRIVILEGE ESCALATION'
                : respLower.includes('shell') || respLower.includes('rce') || respLower.includes('reverse') ? 'SHELL/RCE'
                : respLower.includes('gagal') || respLower.includes('failed') || respLower.includes('denied') ? 'KEGAGALAN'
                : respLower.includes('upload') || respLower.includes('webshell') || respLower.includes('persistence') ? 'PERSISTENCE'
                : /open.?port|port\s+\d+.*open|service|version|apache|nginx|mysql|openssh|endpoint|subnet|alive|host.?found|discover/i.test(respLower) ? 'SCAN/RECON'
                : 'DATA PENTING';
            process.stdout.write(JSON.stringify({
                hookSpecificOutput: {
                    hookEventName: 'PostToolUse',
                    additionalContext: `⚠️ WRITEBACK: ${dataType} terdeteksi di output. SIMPAN ke memori SEKARANG. Alur: (1) memory_get UNLOCK, (2) baca ISI section yang relevan, (3) cek apakah data BARU atau sudah ada (NEW→append, UPDATE→replace_entry, SAMA→SKIP), (4) memory_upsert. DILARANG simpan tanpa cek existing.`
                }
            }));
        } else if (counter >= 30 && counter % 10 === 0) {
            // Fallback: generic warning at 30+ action calls (bukan 10)
            process.stdout.write(JSON.stringify({
                hookSpecificOutput: {
                    hookEventName: 'PostToolUse',
                    additionalContext: `⚠️ WRITEBACK WARNING: ${counter} action calls tanpa memory_upsert. Simpan progress sebelum compaction.`
                }
            }));
        }

        hookLog('INFO', 'PostToolUse logged', {
            tool: toolName,
            target: target || '_AUTO_LOG_UNIFIED',
            entry_len: entry.length,
            redactions,
            ok,
            writeback_counter: counter
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
