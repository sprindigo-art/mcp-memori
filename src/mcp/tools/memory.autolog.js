/**
 * memory.autolog v1.0 — Hook-driven auto-capture writer
 *
 * DESIGN CONSTRAINTS (wajib dipatuhi agar tidak menurunkan kekuatan mcp-memori):
 * 1. Tool ini HANYA menulis ke section `## _AUTO_LOG` (prefix underscore = internal).
 * 2. Section state (CREDENTIAL, EXPLOIT, LIVE STATUS, RE-ENTRY CHECKLIST, GAGAL,
 *    PERSISTENCE, ROOT, CLEANUP) TIDAK BISA ditulis via tool ini — HANYA memory_upsert
 *    dengan hard-block yang boleh sentuh section state.
 * 3. Hard-block read-before-write di-SKIP karena _AUTO_LOG adalah append log yang
 *    tidak pernah jadi source of truth. AI tidak perlu baca log sebelum log.
 * 4. Anti-duplicate & anti-bloat: skip kalau content persis sama dengan 5 entry
 *    terakhir (deteksi tool repeat) atau kalau _AUTO_LOG sudah >50KB → rotate
 *    (keep last 30KB, archive older).
 * 5. Kalau runbook target tidak ada, FALLBACK ke _AUTO_LOG_UNIFIED.md runbook
 *    global (tidak gagal silent, tetap tercatat).
 *
 * @module mcp/tools/memory.autolog
 */
import { readFileSync, existsSync, writeFileSync, renameSync, copyFileSync, appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import {
    RUNBOOKS_DIR,
    titleToFilename,
    findByTitle,
    findByFuzzyTitle,
    parseFrontmatter,
    buildFrontmatter,
    atomicWriteFileSync,
    findSectionEnd,
    filterNoiseTags,
    acquireLock,
    releaseLock
} from '../../storage/files.js';
import { invalidateGetCache } from './memory.get.js';
import { updateIndexEntry } from '../../storage/searchIndex.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger.js';

const AUTOLOG_SECTION = '## _AUTO_LOG';
const AUTOLOG_MAX_SIZE = 50 * 1024;   // 50KB per section → rotate
const AUTOLOG_KEEP_SIZE = 30 * 1024;  // keep last 30KB on rotation
const FALLBACK_RUNBOOK_TITLE = '[RUNBOOK] _AUTO_LOG_UNIFIED';
const DUP_LOOKBACK = 5; // check last 5 entries for exact duplicate

export const definition = {
    name: 'memory_autolog',
    description: 'Internal tool: auto-append hook-captured events to ## _AUTO_LOG section of active target runbook. Bypasses hard-block (section _AUTO_LOG is append-only log, never state of truth). Fallback to _AUTO_LOG_UNIFIED runbook if target not specified. NOT for manual use — use memory_upsert instead.',
    inputSchema: {
        type: 'object',
        properties: {
            target: {
                type: 'string',
                description: 'Target runbook title (e.g. "[RUNBOOK] example.com") or bare target name. If omitted or not found, logs to _AUTO_LOG_UNIFIED.'
            },
            entry: {
                type: 'string',
                description: 'Log entry content. Already scrubbed by the hook. Will be auto-timestamped.'
            },
            event_type: {
                type: 'string',
                description: 'Event category: tool_use, session_start, session_stop, pre_compact, manual'
            },
            tool_name: {
                type: 'string',
                description: 'Name of the tool that triggered this log (Bash, Edit, Write, WebFetch, etc.)'
            }
        },
        required: ['entry']
    }
};

/**
 * Find target runbook path. Returns filepath or null.
 * Uses same fuzzy logic as memory_upsert for consistency.
 */
function resolveTargetRunbook(target) {
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

/**
 * Ensure fallback runbook exists. Creates minimal skeleton if missing.
 */
function ensureFallbackRunbook() {
    const filename = titleToFilename(FALLBACK_RUNBOOK_TITLE);
    const filepath = join(RUNBOOKS_DIR, filename);
    if (existsSync(filepath)) return filepath;

    const now = new Date().toISOString();
    const meta = {
        title: FALLBACK_RUNBOOK_TITLE,
        tags: ['auto-log', 'unified', 'fallback'],
        created: now,
        updated: now,
        version: 1,
        verified: false,
        confidence: 0.3
    };
    const body = `# Unified Auto-Log Runbook\n\n> Fallback destination when hook cannot determine active target.\n> Also used when no target-specific runbook exists yet.\n\n${AUTOLOG_SECTION}\n`;
    atomicWriteFileSync(filepath, buildFrontmatter(meta) + body + '\n', 'utf8');
    logger.info('AUTOLOG: Created fallback runbook', { filepath });
    return filepath;
}

/**
 * Extract _AUTO_LOG section, rotate if too large.
 * Returns { preserved: string (all sections except _AUTO_LOG), autolog: string, rotated: boolean }
 */
const ARCHIVE_DIR = join(RUNBOOKS_DIR, '..', 'archives');

function archiveOldEntries(runbookFilename, oldEntries) {
    try {
        mkdirSync(ARCHIVE_DIR, { recursive: true });
        const date = new Date().toISOString().split('T')[0];
        const baseName = runbookFilename.replace(/\.md$/, '');
        const archivePath = join(ARCHIVE_DIR, `${baseName}_autolog_${date}.log`);
        appendFileSync(archivePath, oldEntries, 'utf8');
        logger.info('AUTOLOG: Archived old entries', { path: archivePath, chars: oldEntries.length });
    } catch (err) {
        logger.warn('AUTOLOG: Archive failed (non-fatal)', { error: err?.message });
    }
}

function splitAndRotate(body, runbookFilename) {
    const idx = body.indexOf(AUTOLOG_SECTION);
    if (idx === -1) {
        return { preserved: body, autolog: '', rotated: false };
    }
    const sectionStart = idx;
    const sectionEnd = findSectionEnd(body, sectionStart);
    const preserved = body.substring(0, sectionStart) + body.substring(sectionEnd);
    let autolog = body.substring(sectionStart, sectionEnd);

    let rotated = false;
    if (autolog.length > AUTOLOG_MAX_SIZE) {
        const header = `${AUTOLOG_SECTION}\n`;
        const entries = autolog.substring(header.length);
        const keep = entries.substring(Math.max(0, entries.length - AUTOLOG_KEEP_SIZE));
        const firstNewline = keep.indexOf('\n');
        const trimmedKeep = firstNewline > 0 ? keep.substring(firstNewline + 1) : keep;
        const oldEntries = entries.substring(0, Math.max(0, entries.length - AUTOLOG_KEEP_SIZE));
        if (oldEntries.length > 0 && runbookFilename) {
            archiveOldEntries(runbookFilename, oldEntries);
        }
        const rotationMarker = `[${new Date().toISOString().split('T')[0]}] _AUTO_LOG rotated, older entries archived to ${ARCHIVE_DIR}\n`;
        autolog = header + rotationMarker + trimmedKeep;
        rotated = true;
        logger.info('AUTOLOG: Rotated section to keep size under limit', { newSize: autolog.length, archived: oldEntries.length });
    }

    return { preserved, autolog, rotated };
}

/**
 * Heal body state from prior race conditions: if `## _AUTO_LOG` appears
 * multiple times, merge all entries into the FIRST occurrence and remove
 * subsequent section headers + entries (they get folded into one section).
 * This is idempotent — safe to call on already-clean body.
 */
function healDuplicateAutolog(body) {
    const header = AUTOLOG_SECTION;
    // Find all positions where header appears at start of line
    const positions = [];
    let searchFrom = 0;
    while (true) {
        const idx = body.indexOf('\n' + header, searchFrom);
        const firstCheck = searchFrom === 0 && body.startsWith(header) ? 0 : -1;
        if (firstCheck === 0 && positions.length === 0) {
            positions.push(0);
            searchFrom = header.length;
            continue;
        }
        if (idx === -1) break;
        positions.push(idx + 1); // +1 to skip the leading \n
        searchFrom = idx + 1 + header.length;
    }
    if (positions.length < 2) return body;

    // Extract entries (lines starting with "- [") from ALL occurrences
    const allEntries = [];
    for (const pos of positions) {
        const end = findSectionEnd(body, pos);
        const sectionText = body.substring(pos, end);
        // Parse entries — lines that start with "- [YYYY-" are log entries
        const lines = sectionText.split('\n');
        for (const line of lines) {
            if (/^- \[\d{4}-\d{2}-\d{2} /.test(line)) {
                allEntries.push(line);
            }
        }
    }

    // Sort entries by timestamp (preserve chronological order)
    allEntries.sort((a, b) => {
        const tsA = a.match(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/)?.[1] || '';
        const tsB = b.match(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/)?.[1] || '';
        return tsA.localeCompare(tsB);
    });

    // Remove ALL _AUTO_LOG sections from body
    let cleanBody = body;
    // Iterate from LAST position to FIRST to preserve indices while removing
    const sortedPos = [...positions].sort((a, b) => b - a);
    for (const pos of sortedPos) {
        const end = findSectionEnd(cleanBody, pos);
        cleanBody = cleanBody.substring(0, pos).trimEnd() + '\n\n' + cleanBody.substring(end);
    }

    // Append unified _AUTO_LOG at end with deduplicated entries
    const uniqueEntries = [];
    const seen = new Set();
    for (const e of allEntries) {
        if (!seen.has(e)) {
            seen.add(e);
            uniqueEntries.push(e);
        }
    }
    cleanBody = cleanBody.trimEnd() + '\n\n' + header + '\n' + uniqueEntries.join('\n') + '\n';
    return cleanBody;
}

/**
 * Check if the new entry duplicates any of the last N entries (anti-spam).
 */
function isDuplicate(autologSection, newEntry) {
    if (!autologSection) return false;
    // Extract last DUP_LOOKBACK entries (separated by \n- or \n[)
    const entries = autologSection.split(/\n(?=- \[|\[)/).slice(-DUP_LOOKBACK);
    const trimmed = newEntry.trim();
    return entries.some(e => e.includes(trimmed));
}

export async function execute(params) {
    const traceId = uuidv4();
    const { target, entry, event_type = 'tool_use', tool_name = 'unknown' } = params || {};

    if (!entry || typeof entry !== 'string' || entry.trim().length === 0) {
        return { ok: false, meta: { trace_id: traceId, error: 'entry required' } };
    }

    // HARD CONSTRAINT: this tool can ONLY write to _AUTO_LOG section.
    // No parameter exists to change section — this is by design.

    let filepath = null;
    let lockHeld = false;
    try {
        // 1. Resolve target runbook, fallback if not found
        filepath = resolveTargetRunbook(target);
        let usedFallback = false;
        if (!filepath) {
            filepath = ensureFallbackRunbook();
            usedFallback = true;
        }

        // 1b. ACQUIRE FILE LOCK BEFORE READ — prevents TOCTOU race when concurrent
        // hook invocations compute diff on stale body and duplicate sections
        acquireLock(filepath);
        lockHeld = true;

        // 2. Read current file (no hard-block check — _AUTO_LOG is append-only log)
        const raw = readFileSync(filepath, 'utf8');
        const { meta, body } = parseFrontmatter(raw);

        // 2b. Dedup ALL occurrences of `## _AUTO_LOG` (heal state from prior races)
        // If section appears twice, merge into one by keeping all entries
        const cleanBody = healDuplicateAutolog(body);

        // 3. Split out current _AUTO_LOG (rotate if too big)
        const runbookFilename = filepath ? filepath.split('/').pop() : null;
        const { preserved, autolog, rotated } = splitAndRotate(cleanBody, runbookFilename);

        // 4. Format new entry with timestamp + tool + event
        const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
        const newEntry = `- [${ts}] [${event_type}/${tool_name}] ${entry.trim()}`;

        // 5. Anti-duplicate: skip if last N entries contain identical content
        if (isDuplicate(autolog, newEntry)) {
            return {
                ok: true,
                action: 'skipped_duplicate',
                filepath,
                meta: { trace_id: traceId, dedup: true }
            };
        }

        // 6. Build updated body
        const header = `${AUTOLOG_SECTION}\n`;
        let updatedAutolog;
        if (autolog) {
            updatedAutolog = autolog.trimEnd() + '\n' + newEntry + '\n';
        } else {
            updatedAutolog = header + newEntry + '\n';
        }
        // Always place _AUTO_LOG at END of body (after all major sections)
        const newBody = preserved.trimEnd() + '\n\n' + updatedAutolog;

        // 7. Metadata update (MINIMAL — don't bump version for auto-log to avoid noise)
        // Only update `updated` timestamp so searchIndex picks up latest access
        meta.updated = new Date().toISOString();
        // DO NOT bump meta.version — manual upsert is source of truth for versioning

        // 8. Merge tags (add auto-log tag if missing, but don't spam)
        const oldTags = Array.isArray(meta.tags) ? meta.tags : [];
        if (!oldTags.includes('auto-log')) {
            meta.tags = filterNoiseTags([...oldTags, 'auto-log']);
        }

        // 9. Inline atomic write WHILE STILL HOLDING LOCK (bypass atomicWriteFileSync's
        // internal lock to avoid double-acquire spinwait). We already hold the lock,
        // so no other writer can race us between read and write.
        const finalContent = buildFrontmatter(meta) + newBody.trim() + '\n';
        const tmpPath = filepath + '.tmp';
        const bakPath = filepath + '.bak';
        if (existsSync(filepath)) {
            try { copyFileSync(filepath, bakPath); } catch {}
        }
        writeFileSync(tmpPath, finalContent, 'utf8');
        renameSync(tmpPath, filepath);

        // 10. Invalidate cache + update FTS index (non-critical, wrap in try)
        try { invalidateGetCache(meta.title ? titleToFilename(meta.title) : filepath.split('/').pop()); } catch {}
        try { updateIndexEntry(filepath.split('/').pop()); } catch {}

        logger.info('AUTOLOG appended', {
            filepath: filepath.split('/').pop(),
            event_type,
            tool_name,
            entry_len: newEntry.length,
            rotated,
            fallback: usedFallback
        });

        return {
            ok: true,
            action: 'appended',
            filepath,
            fallback: usedFallback,
            rotated,
            entry_length: newEntry.length,
            meta: { trace_id: traceId }
        };
    } catch (err) {
        logger.error('AUTOLOG failed', { error: err.message, trace_id: traceId });
        // HOOK CONSTRAINT: never throw. Hooks should not block tool calls.
        return {
            ok: false,
            meta: { trace_id: traceId, error: err.message }
        };
    } finally {
        // Always release lock, even on error (atomicWriteFileSync also tries to
        // acquire but the re-entrant check of existsSync(lockPath) handles it).
        if (lockHeld && filepath) {
            try { releaseLock(filepath); } catch {}
        }
    }
}

export default { definition, execute };
