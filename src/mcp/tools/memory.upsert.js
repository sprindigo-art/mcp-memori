/**
 * memory.upsert v7.0 — File-based Runbook Storage with Intelligence Layer
 * ALL saves go to .md files. APPEND-ONLY: never delete valid content.
 * v7.0: Universal error tracking, technique auto-save, auto-invalidation
 * WAJIB memory_get dulu jika runbook SUDAH ADA — agar tahu isinya sebelum append
 * @module mcp/tools/memory.upsert
 */
import { saveRunbook, titleToFilename, findByTitle, findByFuzzyTitle, RUNBOOKS_DIR, parseFrontmatter, buildFrontmatter, filterNoiseTags, appendToSection, findSectionEnd, isMajorSection, atomicWriteFileSync, acquireLock, releaseLock } from '../../storage/files.js';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { hasBeenRead, getReadStatus } from './memory.forget.js';
import { routeMemoryType } from '../../utils/memoryTypeRouter.js';
import { invalidateGetCache } from './memory.get.js';
import { updateIndexEntry } from '../../storage/searchIndex.js';
import { updateVectorEntry } from '../../storage/vectorIndex.js';
import { updateGraphEntry } from '../../storage/graphIndex.js';
import logger from '../../utils/logger.js';

const AUTO_MEMORY_PATH = '/home/kali/.claude/projects/-home-kali-Desktop/memory/MEMORY.md';

const contentDedupMap = new Map();

function isContentHashDuplicate(sectionName, content) {
    const now = Date.now();
    const COOLDOWN_MS = 600000; // 10 minutes (was 120s — too short, post-compaction re-upsert lolos)
    if (contentDedupMap.size > 500) {
        for (const [k, v] of contentDedupMap) {
            if ((now - v) > COOLDOWN_MS) contentDedupMap.delete(k);
        }
    }
    const full = (content || '').trim();
    const hashInput = (sectionName || '') + '::' + full.substring(0, 500) + '::' + full.length;
    const hash = createHash('sha256').update(hashInput, 'utf8').digest('hex');
    const existing = contentDedupMap.get(hash);
    if (existing && (now - existing) < COOLDOWN_MS) return true;
    contentDedupMap.set(hash, now);
    return false;
}

/**
 * v7.5: Update all index layers (FTS5 + vector + graph) for a filename
 * Replaces individual try/catch blocks throughout the file
 */
function updateAllIndexes(filename) {
    try { updateIndexEntry(filename); } catch (e) { logger.warn('FTS5 index update failed', { filename, error: e?.message }); }
    updateVectorEntry(filename).catch(e => { logger.warn('Vector index update failed', { filename, error: e?.message }); });
    try { updateGraphEntry(filename); } catch (e) { logger.warn('Graph index update failed', { filename, error: e?.message }); }
}

/**
 * Auto-update MEMORY.md "TARGET AKTIF TERAKHIR" saat upsert ke RUNBOOK target
 */
function updateActiveTarget(title, filename) {
    if (!title.toLowerCase().startsWith('[runbook]')) return;
    if (!existsSync(AUTO_MEMORY_PATH)) return;

    try {
        const targetName = title.replace(/^\[RUNBOOK\]\s*/i, '').trim();
        const now = new Date().toISOString().split('T')[0];
        let content = readFileSync(AUTO_MEMORY_PATH, 'utf8');

        // Replace target line
        content = content.replace(
            /- Target:.*$/m,
            `- Target: ${targetName} (updated ${now})`
        );
        // Replace checkpoint line
        content = content.replace(
            /- Checkpoint:.*$/m,
            `- Checkpoint: Last upsert ${now} → ${filename}`
        );

        writeFileSync(AUTO_MEMORY_PATH, content, 'utf8');
        logger.info('AUTO-MEMORY updated active target', { target: targetName, filename });
    } catch (err) {
        logger.warn('AUTO-MEMORY update failed (non-fatal)', { error: err.message });
    }
}

export const definition = {
    name: 'memory_upsert',
    description: 'Simpan atau update runbook (.md file). Append-only: content lama TIDAK dihapus. WAJIB memory_get dulu jika runbook sudah ada — agar tidak kehilangan context.',
    inputSchema: {
        type: 'object',
        properties: {
            items: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        type: { type: 'string', description: 'Auto-converted to runbook' },
                        project_id: { type: 'string', description: 'Project ID' },
                        title: { type: 'string', description: 'Runbook title, e.g. [RUNBOOK] target.com or [TEKNIK] GeoServer RCE' },
                        content: { type: 'string', description: 'Content to append to runbook' },
                        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for search' },
                        verified: { type: 'boolean' },
                        confidence: { type: 'number' },
                        success: { type: 'boolean', description: 'Whether the action succeeded' },
                        replace_section: { type: 'string', description: 'Replace existing ## section with new content instead of append. Section name without ## prefix (e.g. "CREDENTIAL", "RE-ENTRY CHECKLIST"). If section not found, appends instead.' },
                        replace_text: { type: 'string', description: 'Find this exact text in the runbook and replace it with content. Like Edit tool — surgical edit without replacing entire section. Text must be unique in the file.' },
                        replace_entry: { type: 'string', description: 'Replace a ### entry by its title (fuzzy match). Finds the ### heading that best matches this string and replaces everything from that ### to the next ### or ## with new content. Use when updating existing entry with newer data (e.g. "dbcluster1 MySQL ROOT" to update old entry about dbcluster1).' },
                        append_to_section: { type: 'string', description: 'Append content to END of specific ## section (preserving ALL existing content in that section). Section name without ## prefix (e.g. "CREDENTIAL", "GAGAL", "EXPLOIT"). If section not found, creates it. RECOMMENDED over replace_section for adding entries.' },
                        auto_dual_save: { type: 'boolean', description: 'If true, auto-save failures to Kesalahan Universal + successes to Teknik Berhasil Universal. Default: false. Only set true when you want cross-target learning.' },
                        memory_type: { type: 'string', description: 'Auto-route to correct section: credential, exploit_success, exploit_failure, status, recon, todo, blocker, command, lesson, decision, environment. Only used when append_to_section/replace_section/replace_text/replace_entry are NOT set.' }
                    },
                    required: ['title', 'content']
                },
                description: 'Runbook items to save'
            }
        },
        required: ['items']
    }
};

/**
 * v7.2: Auto-save errors to [TEKNIK] Kesalahan Universal Anti-Repeat Registry
 * Uses the EXISTING file that already has 332+ compiled errors
 * Every REAL failure across ANY target gets collected here for cross-target learning
 *
 * STRICT FILTER: Only save lines that describe an actual FAILED action/technique
 * NOT status descriptions like "vpxd DEAD" or "credential DEAD" (those are states, not errors)
 */
function autoSaveUniversalError(item, result) {
    const title = (item.title || '').toLowerCase();

    // Only for target runbooks and technique runbooks
    if (!title.startsWith('[runbook]') && !title.startsWith('[teknik]')) return;

    const rawContent = item.content || '';

    // STRICT: Must contain explicit failure action words (not just status words)
    // "GAGAL upload webshell" = YES (action failed)
    // "vpxd DEAD since 2023" = NO (status description)
    // "credential DEAD" = NO (status update)
    const failureActionPattern = /(?:GAGAL|FAILED|BLOCKED|DITOLAK|REJECTED|NOT WORKING|TIDAK BERHASIL|EXPLOIT FAILED|TIMEOUT saat|ERROR saat|sudah dipatch|already patched|error:.+(?:connection|permission|denied|refused|500|403|404))/i;
    if (!failureActionPattern.test(rawContent)) return;

    // Extract ONLY lines that describe actual failed actions
    const failLines = rawContent.split('\n')
        .filter(l => {
            // Must match failure action, not just contain "dead" or "error" as status
            if (failureActionPattern.test(l)) return true;
            // Also include lines right after failure that explain why
            if (/(?:alasan|reason|cause|karena|because|→.*(?:gagal|fail))/i.test(l)) return true;
            return false;
        })
        .slice(0, 8)
        .join('\n');

    if (!failLines.trim()) return;

    const targetName = title.startsWith('[runbook]')
        ? (item.title || '').replace(/^\[RUNBOOK\]\s*/i, '').trim()
        : (item.title || '').replace(/^\[TEKNIK\]\s*/i, '').trim();
    const now = new Date().toISOString().split('T')[0];

    try {
        // Save to EXISTING file: [TEKNIK] Kesalahan Universal Anti-Repeat Registry
        const errorEntry = `\n### ${now} — ${targetName}\n${failLines}\n- Source: auto-saved from ${item.title}\n`;
        saveRunbook(
            '[TEKNIK] Kesalahan Universal Anti-Repeat Registry',
            errorEntry,
            ['universal', 'kesalahan', 'anti-repeat', targetName.toLowerCase().split('.')[0]],
            { success: false }
        );
        logger.info('AUTO-SAVE universal error to Anti-Repeat Registry', { target: targetName });

        // Also update FTS5 index
        try { updateIndexEntry('TEKNIK_Kesalahan_Universal_Anti_Repeat.md'); } catch {}
    } catch (err) {
        logger.warn('Universal error auto-save failed (non-fatal)', { error: err.message });
    }
}

/**
 * v7.1: Auto dual-save technique to [TEKNIK] runbook
 * When a successful technique is saved to [RUNBOOK] target, AUTO-SAVE to [TEKNIK] too
 * Returns reminder string for what was auto-saved
 */
function autoSaveTechnique(item) {
    const title = (item.title || '').toLowerCase();
    const content = (item.content || '');

    // Only for target runbooks
    if (!title.startsWith('[runbook]')) return null;

    // v7.3 FIX: Detect REAL success, NOT content that mentions technique in failure context
    // CRITICAL: "TIDAK BERHASIL" / "NOT WORKING" must NOT count as success
    const hasTechniqueKeyword = /(?:cve-|exploit|rce|sqli|xss|ssrf|xxe|lfi|rfi|deserialization|bypass|injection|upload|webshell|reverse.shell)/i.test(content);

    // Strip negated success phrases BEFORE checking for success signals
    const contentForSuccess = content
        .replace(/TIDAK\s+BERHASIL/gi, '_NEG_')
        .replace(/NOT\s+(?:WORKING|SUCCESS)/gi, '_NEG_')
        .replace(/BELUM\s+BERHASIL/gi, '_NEG_');
    const hasSuccessSignal = /(?:berhasil|success|achieved|working|shell obtained|root obtained|rce confirmed|access gained)/i.test(contentForSuccess);
    const hasFailureSignal = /(?:GAGAL|FAILED|BLOCKED|DITOLAK|REJECTED|TIDAK BERHASIL|EXPLOIT FAILED|NOT WORKING|sudah dipatch|already patched)/i.test(content);

    // Count failure vs success lines to determine overall intent
    const lines = content.split('\n');
    const failLines = lines.filter(l => /(?:GAGAL|FAILED|BLOCKED|DITOLAK|TIDAK BERHASIL|EXPLOIT FAILED|NOT WORKING|dipatch|patched)/i.test(l)).length;
    const successLines = lines.filter(l => {
        const cleaned = l.replace(/TIDAK\s+BERHASIL/gi, '').replace(/NOT\s+(?:WORKING|SUCCESS)/gi, '').replace(/BELUM\s+BERHASIL/gi, '');
        return /(?:berhasil|success|achieved|shell obtained|rce confirmed|access gained)/i.test(cleaned);
    }).length;

    // SKIP if: no technique keyword, no REAL success signal, OR more failure lines than success lines
    if (!hasTechniqueKeyword || !hasSuccessSignal) return null;
    if (hasFailureSignal && failLines >= successLines) return null;

    // Extract technique name
    const cveMatch = content.match(/CVE-\d{4}-\d{4,}/i);
    const techniquePatterns = [
        /teknik[:\s]+([^\n]+)/i,
        /exploit[:\s]+([^\n]+)/i,
        /method[:\s]+([^\n]+)/i,
        /menggunakan\s+([^\n,]+)/i
    ];

    let techniqueName = cveMatch ? cveMatch[0] : null;
    if (!techniqueName) {
        for (const pattern of techniquePatterns) {
            const match = content.match(pattern);
            if (match) { techniqueName = match[1].trim().substring(0, 80); break; }
        }
    }

    if (!techniqueName) return null;

    // Extract target name from title
    const targetName = (item.title || '').replace(/^\[RUNBOOK\]\s*/i, '').trim();
    const now = new Date().toISOString().split('T')[0];

    // Extract relevant lines (commands, outcomes)
    const relevantLines = content.split('\n')
        .filter(l => /(?:command|berhasil|success|exploit|shell|root|rce|bypass|http|curl|wget|python)/i.test(l))
        .slice(0, 15)
        .join('\n');

    if (!relevantLines.trim()) return null;

    // AUTO-SAVE to per-technique runbook: [TEKNIK] {nama}
    try {
        const teknikContent = `\n### ${now} — Tested on: ${targetName}\n${relevantLines}\n- Status: SUCCESS\n`;
        const teknikTags = ['teknik', techniqueName.toLowerCase().replace(/[^a-z0-9]/g, '-'), targetName.toLowerCase().split('.')[0]];

        saveRunbook(`[TEKNIK] ${techniqueName}`, teknikContent, teknikTags, { success: true });
        logger.info('AUTO DUAL-SAVE technique (per-teknik)', { technique: techniqueName, target: targetName });

        // Also update FTS5 index for per-technique file
        try { updateIndexEntry(titleToFilename(`[TEKNIK] ${techniqueName}`)); } catch {}

        // v7.2: ALSO save to consolidated registry: [TEKNIK] Teknik Berhasil Universal
        // This is ONE file that collects ALL successful techniques for cross-target reuse
        try {
            const consolidatedEntry = `\n### ${now} — ${techniqueName} @ ${targetName}\n- Teknik: ${techniqueName}\n- Target: ${targetName}\n- Detail: ${relevantLines.split('\n').slice(0, 5).join(' | ')}\n- Status: SUCCESS\n`;
            saveRunbook(
                '[TEKNIK] Teknik Berhasil Universal',
                consolidatedEntry,
                ['universal', 'teknik-berhasil', 'registry', techniqueName.toLowerCase().replace(/[^a-z0-9]/g, '-')],
                { success: true }
            );
            logger.info('AUTO-SAVE to Teknik Berhasil Universal', { technique: techniqueName, target: targetName });
            try { updateIndexEntry('TEKNIK_Teknik_Berhasil_Universal.md'); } catch {}
        } catch (consolidateErr) {
            logger.warn('Consolidated technique save failed (non-fatal)', { error: consolidateErr.message });
        }

        return `✅ AUTO DUAL-SAVE: Teknik "${techniqueName}" berhasil di ${targetName} → tersimpan ke [TEKNIK] ${techniqueName} + [TEKNIK] Teknik Berhasil Universal`;
    } catch (err) {
        logger.warn('Auto technique save failed', { error: err.message, technique: techniqueName });
        return `⚠️ DUAL-SAVE GAGAL: Teknik "${techniqueName}" tidak bisa auto-save ke [TEKNIK]. Manual save diperlukan.`;
    }
}

/**
 * v7.0: Auto-detect and mark invalidated techniques/credentials
 * Returns reminder if content indicates something was patched/dead
 */
function checkAutoInvalidation(item) {
    const content = (item.content || '');
    const title = (item.title || '').toLowerCase();
    const reminders = [];

    // Detect PATCHED signals
    if (/(?:sudah di.?patch|already patched|patch applied|vulnerability fixed|not vulnerable|patched)/i.test(content)) {
        if (title.startsWith('[teknik]')) {
            reminders.push('⚠️ AUTO-INVALIDATION: Teknik ini terdeteksi sudah PATCHED di target. Update section ## PATCHED TARGETS di runbook teknik ini.');
        } else if (title.startsWith('[runbook]')) {
            reminders.push('⚠️ AUTO-INVALIDATION: Exploit/teknik terdeteksi sudah PATCHED. Update ## GAGAL section dengan alasan "PATCHED" + tanggal.');
        }
    }

    // Detect DEAD credential signals
    if (/(?:password changed|credential.*(dead|expired|invalid|revoked)|access denied|connection refused|authentication failed)/i.test(content)) {
        if (title.startsWith('[runbook]')) {
            reminders.push('⚠️ CREDENTIAL DEAD: Terdeteksi credential/akses yang sudah tidak valid. Update ## LIVE STATUS dengan replace_section untuk mark DEAD.');
        }
    }

    // Detect version upgrade (target updated, techniques may not work)
    if (/(?:upgraded to|updated to version|new version|version \d+\.\d+)/i.test(content)) {
        reminders.push('⚠️ VERSION CHANGE: Terdeteksi perubahan versi di target. Validasi ulang semua teknik yang terdaftar di runbook ini.');
    }

    return reminders;
}

export async function execute(params) {
    const traceId = uuidv4();
    let { items } = params;

    // v7.1 FIX: Defensive parsing — Claude Code sometimes sends items as JSON string instead of array
    if (typeof items === 'string') {
        try {
            items = JSON.parse(items);
            logger.info('UPSERT: items was string, parsed to array', { count: items.length });
        } catch (parseErr) {
            logger.error('UPSERT: items string is not valid JSON', { error: parseErr.message, preview: items.substring(0, 200) });
            return { upserted: [], meta: { trace_id: traceId, error: 'items is not valid JSON array: ' + parseErr.message } };
        }
    }

    // Ensure items is actually an array of objects
    if (!Array.isArray(items)) {
        // Last resort: wrap single object in array
        if (items && typeof items === 'object' && items.title) {
            items = [items];
        } else {
            return { upserted: [], meta: { trace_id: traceId, error: 'items must be an array, got: ' + typeof items } };
        }
    }

    if (items.length === 0) {
        return { upserted: [], meta: { trace_id: traceId, error: 'No items provided' } };
    }

    // Validate each item is an object (not a character from string iteration)
    items = items.filter(item => {
        if (!item || typeof item !== 'object') {
            logger.warn('UPSERT: Skipping invalid item (not object)', { type: typeof item, value: String(item).substring(0, 50) });
            return false;
        }
        return true;
    });

    if (items.length === 0) {
        return { upserted: [], meta: { trace_id: traceId, error: 'No valid items after filtering (items may have been sent as string instead of array)' } };
    }

    const results = [];
    const contradictions = []; // Collect contradiction warnings from appendToSection

    for (const item of items) {
        try {
            const title = item.title || 'Untitled Runbook';
            const content = item.content || '';
            const tags = item.tags || [];
            const options = {
                verified: item.verified,
                confidence: item.confidence,
                success: item.success
            };

            // Cek apakah runbook sudah ada (by filename atau by frontmatter title)
            const filename = titleToFilename(title);
            let filepath = join(RUNBOOKS_DIR, filename);
            let actualFilename = filename;
            let fileExists = existsSync(filepath);

            // Fallback 1: cari by frontmatter title (title beda sanitization → filename beda)
            if (!fileExists) {
                const matchedPath = findByTitle(title);
                if (matchedPath) {
                    filepath = matchedPath;
                    actualFilename = basename(matchedPath);
                    fileExists = true;
                }
            }

            // Fallback 2: FUZZY title match — "[RUNBOOK] unitomo" → match "RUNBOOK_unitomo.ac.id.md"
            // Prevents creating duplicate runbooks for the same target
            if (!fileExists) {
                const fuzzyPath = findByFuzzyTitle(title);
                if (fuzzyPath) {
                    filepath = fuzzyPath;
                    actualFilename = basename(fuzzyPath);
                    fileExists = true;
                    logger.info('UPSERT FUZZY MATCH: Found similar runbook', { title, matched: actualFilename });
                }
            }

            // === HARD BLOCK: Runbook SUDAH ADA tapi BELUM dibaca → TOLAK ===
            if (fileExists && !hasBeenRead(actualFilename)) {
                const readStatus = getReadStatus(actualFilename);
                logger.warn('UPSERT BLOCKED: runbook exists but not read first', { filename: actualFilename, title, readStatus });
                results.push({
                    id: actualFilename,
                    version: 0,
                    status: 'blocked',
                    action: 'rejected',
                    read_status: readStatus,
                    error: `BLOCKED: Runbook "${actualFilename}" sudah ada tapi BELUM dibaca cukup. `
                        + `Status: ${readStatus.reason}${readStatus.mode ? ` (mode=${readStatus.mode}, chars=${readStatus.charsRead || 0})` : ''}. `
                        + `FIX: (1) memory_get({id:"${actualFilename}"}) TANPA section → UNLOCK. `
                        + `(2) Read /home/kali/Desktop/mcp-memori/runbooks/${actualFilename} bertahap (offset/limit) → BACA ISI. `
                        + `(3) Cek existing entries di section → data BARU atau UPDATE? Baru boleh upsert.`
                });
                continue;
            }

            // === MEMORY_TYPE AUTO-ROUTING (v8.7) ===
            // If memory_type is set but no explicit write mode, route to correct section automatically
            if (item.memory_type && !item.append_to_section && !item.replace_section && !item.replace_text && !item.replace_entry) {
                const route = routeMemoryType(item.memory_type);
                if (route && route.error) {
                    results.push({ id: actualFilename, version: 0, status: 'error', action: 'invalid_memory_type', error: route.error });
                    continue;
                }
                if (route) {
                    if (route.mode === 'replace_section') item.replace_section = route.section;
                    else item.append_to_section = route.section;
                    if (route.dual_save && item.auto_dual_save === undefined) item.auto_dual_save = true;
                }
            }

            // === APPEND TO SECTION MODE: Tambah content ke END of section yang benar ===
            // PRESERVES semua content lama di section. Ideal untuk: credential, gagal, exploit, persistence
            // v8.5: Full read→check→write wrapped in file lock to prevent multi-AI race condition
            if (item.append_to_section && fileExists) {
                try {
                    if (isContentHashDuplicate(item.append_to_section, content)) {
                        results.push({
                            id: actualFilename, version: 0, status: 'active',
                            action: 'skipped_content_hash_dedup', section: item.append_to_section, filepath
                        });
                        continue;
                    }

                    acquireLock(filepath);
                    try {
                        const raw = readFileSync(filepath, 'utf8');
                        const { meta, body } = parseFrontmatter(raw);

                        const appendResult = appendToSection(body, item.append_to_section, content);
                        const { body: newBody, action: appendAction, contradiction, overlapWarning, overlappingEntry, existingEntryTitles } = appendResult;

                        if (contradiction) {
                            contradictions.push(`⚠️ CONTRADICTION in ## ${item.append_to_section} of ${actualFilename}: ${contradiction}`);
                        }
                        if (overlapWarning) {
                            contradictions.push(overlapWarning);
                        }

                        if (appendAction === 'overlap_blocked') {
                            const matchedTitle = (overlappingEntry || '').match(/^(?:\[\d{4}[^\]]*\]\s*)?###\s+(.+)/m)?.[1] || '';
                            results.push({
                                id: actualFilename, version: meta.version || 1, status: 'blocked',
                                action: 'overlap_blocked', section: item.append_to_section, filepath,
                                existing_entry: overlappingEntry || '',
                                existing_titles: existingEntryTitles || [],
                                fix_update: matchedTitle ? `memory_upsert({items:[{title:"${item.title}", replace_entry:"### ${matchedTitle}", content:"DATA BARU DISINI"}]})` : null,
                                fix_explanation: `BLOCKED karena entry mirip sudah ada. INI BUKAN BUG. Pilih salah satu:\n1. UPDATE entry lama: gunakan replace_entry:"### ${matchedTitle || 'TITLE_EXISTING'}"\n2. Entry genuinely BARU (IP/service BEDA): coba append_to_section lagi dengan content yang tidak overlap — AKAN LOLOS\n3. JANGAN bypass pakai Write/Edit/Bash ke file .md`
                            });
                            continue;
                        }
                        if (appendAction === 'skipped_duplicate' || appendAction === 'skipped_near_duplicate') {
                            results.push({
                                id: actualFilename, version: meta.version || 1, status: 'active',
                                action: appendAction, section: item.append_to_section, filepath
                            });
                            if (appendAction === 'skipped_near_duplicate') {
                                contradictions.push(`ℹ️ NEAR-DUPLICATE BLOCKED: >60% baris content sudah ada di ## ${item.append_to_section} — skip untuk cegah duplikasi.`);
                            }
                            continue;
                        }

                        const oldTags = Array.isArray(meta.tags) ? meta.tags : [];
                        meta.tags = filterNoiseTags([...new Set([...oldTags, ...tags.map(t => t.toLowerCase())])]);
                        meta.updated = new Date().toISOString();
                        meta.version = (meta.version || 1) + 1;
                        if (options.success !== undefined) meta.success = options.success;

                        atomicWriteFileSync(filepath, buildFrontmatter(meta) + newBody.trim() + '\n', 'utf8');
                        invalidateGetCache(actualFilename);
                        updateAllIndexes(actualFilename);
                        updateActiveTarget(title, actualFilename);

                        logger.info('SECTION APPEND', {
                            filename: actualFilename, section: item.append_to_section,
                            action: appendAction, added_chars: content.length
                        });

                        let verifiedChars = 0;
                        try {
                            const verifyRaw = readFileSync(filepath, 'utf8');
                            const { body: verifyBody } = parseFrontmatter(verifyRaw);
                            verifiedChars = verifyBody.length;
                        } catch {}

                        results.push({
                            id: actualFilename, version: meta.version, status: 'active',
                            action: appendAction, section: item.append_to_section, filepath,
                            verified_total_chars: verifiedChars,
                            existing_entries: (existingEntryTitles || []).slice(0, 10)
                        });
                        continue;
                    } finally {
                        releaseLock(filepath);
                    }
                } catch (appendErr) {
                    logger.error('Append to section error', { error: appendErr.message, filename: actualFilename });
                    results.push({ id: actualFilename, status: 'error', action: 'append_error', error: appendErr.message, filepath });
                    continue;
                }
            }

            // === REPLACE TEXT MODE: Edit spesifik — cari teks lama, ganti dengan teks baru ===
            // v8.5: Full read→check→write wrapped in file lock to prevent multi-AI race condition
            if (item.replace_text && fileExists) {
                try {
                    acquireLock(filepath);
                    try {
                        const raw = readFileSync(filepath, 'utf8');
                        const { meta, body } = parseFrontmatter(raw);
                        const oldText = item.replace_text;
                        const newText = content;

                        const occurrences = body.split(oldText).length - 1;
                        if (occurrences === 0) {
                            results.push({
                                id: actualFilename, version: meta.version || 1, status: 'error',
                                action: 'replace_text_not_found',
                                error: `Text not found in runbook. Make sure replace_text matches exactly.`,
                                preview: oldText.substring(0, 100)
                            });
                            continue;
                        }
                        if (occurrences > 1) {
                            results.push({
                                id: actualFilename, version: meta.version || 1, status: 'error',
                                action: 'replace_text_ambiguous',
                                error: `Text found ${occurrences} times — must be unique. Provide more context to make it unique.`,
                                preview: oldText.substring(0, 100)
                            });
                            continue;
                        }

                        const newBody = body.replace(oldText, newText);

                        const now = new Date().toISOString().split('T')[0];
                        const changelogEntry = `- ${now} v${(meta.version || 1) + 1}: replace_text (${oldText.length} → ${newText.length} chars)`;
                        const changelogHeader = '## _CHANGELOG';
                        let finalBody = newBody;
                        if (finalBody.includes(changelogHeader)) {
                            finalBody = finalBody.replace(changelogHeader, `${changelogHeader}\n${changelogEntry}`);
                        } else {
                            finalBody = finalBody.trim() + `\n\n${changelogHeader}\n${changelogEntry}\n`;
                        }

                        const oldTags = Array.isArray(meta.tags) ? meta.tags : [];
                        meta.tags = filterNoiseTags([...new Set([...oldTags, ...tags.map(t => t.toLowerCase())])]);
                        meta.updated = new Date().toISOString();
                        meta.version = (meta.version || 1) + 1;

                        atomicWriteFileSync(filepath, buildFrontmatter(meta) + finalBody.trim() + '\n', 'utf8');
                        invalidateGetCache(actualFilename);
                        updateAllIndexes(actualFilename);
                        updateActiveTarget(title, actualFilename);

                        logger.info('TEXT REPLACED', { filename: actualFilename, old_len: oldText.length, new_len: newText.length });

                        results.push({
                            id: actualFilename, version: meta.version, status: 'active',
                            action: 'text_replaced', old_length: oldText.length,
                            new_length: newText.length, filepath
                        });
                        continue;
                    } finally {
                        releaseLock(filepath);
                    }
                } catch (replaceErr) {
                    logger.error('Replace text error', { error: replaceErr.message, filename: actualFilename });
                    results.push({ id: actualFilename, status: 'error', action: 'replace_text_error', error: replaceErr.message, filepath });
                    continue;
                }
            }

            // === REPLACE SECTION MODE: Ganti section yang sudah tidak valid ===
            // v7.4 FIX: Use findSectionEnd (respects isMajorSection) instead of regex
            // Old regex [\s\S]*?(?=\n## |$) stopped at ANY ## including sub-headings → truncated sections
            if (item.replace_section && fileExists) {
                // v7.6: Restrict replace_section to LIVE STATUS / RE-ENTRY only (workflow rule enforcement)
                const allowedReplaceSections = ['live status', 're-entry checklist', 're-entry', '_changelog'];
                const replaceSectionLower = item.replace_section.toLowerCase().replace(/^##\s*/, '');
                if (!allowedReplaceSections.includes(replaceSectionLower)) {
                    contradictions.push(`⚠️ REPLACE_SECTION BLOCKED: Section "${item.replace_section}" tidak boleh di-replace total. Gunakan append_to_section untuk tambah data, atau replace_text untuk edit surgical. replace_section HANYA untuk: LIVE STATUS, RE-ENTRY CHECKLIST.`);
                    results.push({
                        id: actualFilename,
                        version: 0,
                        status: 'blocked',
                        action: 'replace_section_restricted',
                        section: item.replace_section,
                        allowed_sections: ['LIVE STATUS', 'RE-ENTRY CHECKLIST'],
                        filepath
                    });
                    continue;
                }
                // v8.5: Full read→check→write wrapped in file lock to prevent multi-AI race condition
                try {
                    acquireLock(filepath);
                    try {
                        const raw = readFileSync(filepath, 'utf8');
                        const { meta, body } = parseFrontmatter(raw);
                        const sectionHeader = item.replace_section.startsWith('##') ? item.replace_section : `## ${item.replace_section}`;
                        const escapedHeader = sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        const headerRegex = new RegExp(`^${escapedHeader}(?:\\s*$|\\s+&)`, 'im');
                        let headerMatch = headerRegex.exec(body);
                        if (!headerMatch) {
                            const inlineIdx = body.indexOf(sectionHeader);
                            if (inlineIdx > 0) {
                                body = body.substring(0, inlineIdx) + '\n' + body.substring(inlineIdx);
                                headerMatch = headerRegex.exec(body);
                                if (headerMatch) logger.info('HEALED corrupted section header (missing newline)', { section: item.replace_section, pos: inlineIdx });
                            }
                        }

                        let newBody;
                        if (headerMatch) {
                            const sectionStart = headerMatch.index;
                            let sectionEnd = findSectionEnd(body, sectionStart);

                            // Consolidate duplicate section headers (e.g. 2+ ## LIVE STATUS from legacy/bug)
                            const scanRegex = new RegExp(`^${escapedHeader}(?:\\s*$|\\s+&)`, 'gim');
                            let dupMatch;
                            while ((dupMatch = scanRegex.exec(body)) !== null) {
                                if (dupMatch.index > sectionStart) {
                                    const dupEnd = findSectionEnd(body, dupMatch.index);
                                    if (dupEnd > sectionEnd) sectionEnd = dupEnd;
                                }
                            }

                            const oldSection = body.substring(sectionStart, sectionEnd);

                            // Strip duplicate section header from content if user included it
                            const contentHeaderRegex = new RegExp(`^##\\s+${item.replace_section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n`, 'i');
                            const cleanContent = content.replace(contentHeaderRegex, '');

                            // TRUNCATION GUARD: warn if new content < 30% of old (likely truncated)
                            const oldBody = oldSection.replace(/^##[^\n]*\n/, '').trim();
                            if (oldBody.length > 200 && cleanContent.trim().length < oldBody.length * 0.3) {
                                logger.warn('REPLACE_SECTION TRUNCATION WARNING', { section: item.replace_section, old_chars: oldBody.length, new_chars: cleanContent.trim().length });
                                contradictions.push(`⚠️ TRUNCATION WARNING: New content (${cleanContent.trim().length} chars) is <30% of old (${oldBody.length} chars) for ## ${item.replace_section}. Kemungkinan data terpotong. Cek content sebelum confirm.`);
                            }

                            newBody = body.substring(0, sectionStart) + `${sectionHeader}\n${cleanContent}\n\n` + body.substring(sectionEnd);
                            logger.info('SECTION REPLACED', { filename: actualFilename, section: item.replace_section, old_size: oldSection.length, new_size: content.length });

                            const now = new Date().toISOString().split('T')[0];
                            const changelogEntry = `- ${now} v${(meta.version || 1) + 1}: replaced ## ${item.replace_section} (${oldSection.length} → ${content.length} chars)`;
                            const changelogHeader = '## _CHANGELOG';
                            if (newBody.includes(changelogHeader)) {
                                newBody = newBody.replace(changelogHeader, `${changelogHeader}\n${changelogEntry}`);
                            } else {
                                newBody = newBody.trim() + `\n\n${changelogHeader}\n${changelogEntry}\n`;
                            }
                        } else {
                            newBody = body.trim() + `\n\n${sectionHeader}\n${content}\n`;
                            logger.info('SECTION NOT FOUND, APPENDED', { filename: actualFilename, section: item.replace_section });
                        }

                        const oldTags = Array.isArray(meta.tags) ? meta.tags : [];
                        meta.tags = filterNoiseTags([...new Set([...oldTags, ...tags.map(t => t.toLowerCase())])]);
                        meta.updated = new Date().toISOString();
                        meta.version = (meta.version || 1) + 1;

                        atomicWriteFileSync(filepath, buildFrontmatter(meta) + newBody.trim() + '\n', 'utf8');
                        invalidateGetCache(actualFilename);
                        updateAllIndexes(actualFilename);
                        updateActiveTarget(title, actualFilename);

                        results.push({
                            id: actualFilename, version: meta.version, status: 'active',
                            action: headerMatch ? 'section_replaced' : 'section_appended',
                            section: item.replace_section, filepath
                        });
                        continue;
                    } finally {
                        releaseLock(filepath);
                    }
                } catch (replaceErr) {
                    logger.error('Replace section error', { error: replaceErr.message, filename: actualFilename });
                    results.push({ id: actualFilename, status: 'error', action: 'replace_section_error', error: replaceErr.message, filepath });
                    continue;
                }
            }

            // === REPLACE ENTRY MODE: Ganti entry berdasarkan ### title (fuzzy match) ===
            if (item.replace_entry && fileExists) {
                try {
                    acquireLock(filepath);
                    try {
                        const raw = readFileSync(filepath, 'utf8');
                        const { meta, body } = parseFrontmatter(raw);
                        const searchTitle = item.replace_entry.replace(/^###\s*/, '').trim().toLowerCase();

                        // Find ### entry by fuzzy title match (handles [YYYY-MM-DD] date prefix from appendToSection)
                        const entryRegex = /^(?:\[\d{4}[^\]]*\]\s*)?###\s+.+$/gm;
                        const midLineRegex = /(?<=.)(?:\[\d{4}[^\]]*\]\s*)?###\s+.+$/gm;
                        const allMatches = [];
                        let match;
                        while ((match = entryRegex.exec(body)) !== null) {
                            allMatches.push({ index: match.index, header: match[0].trim() });
                        }
                        while ((match = midLineRegex.exec(body)) !== null) {
                            const header = match[0].trim();
                            if (!allMatches.some(m => m.header === header && Math.abs(m.index - match.index) < header.length + 5)) {
                                allMatches.push({ index: match.index, header });
                            }
                        }

                        let bestMatch = null;
                        let bestScore = 0;
                        let secondBestScore = 0;
                        let secondBestTitle = '';
                        for (const entry of allMatches) {
                            const entryTitle = entry.header.replace(/^(?:\[\d{4}[^\]]*\]\s*)?###\s+/, '').trim().toLowerCase();
                            let score = 0;
                            if (entryTitle === searchTitle) score = 100;
                            else if (entryTitle.includes(searchTitle)) score = 80;
                            else if (searchTitle.includes(entryTitle)) score = 70;
                            else {
                                const searchWords = searchTitle.split(/[\s\-_.,]+/).filter(w => w.length >= 3);
                                const entryWords = entryTitle.split(/[\s\-_.,]+/).filter(w => w.length >= 3);
                                const overlap = searchWords.filter(w => entryWords.some(ew => ew.includes(w) || w.includes(ew))).length;
                                if (searchWords.length > 0) score = (overlap / searchWords.length) * 60;
                            }
                            if (score > bestScore) {
                                secondBestScore = bestScore;
                                secondBestTitle = bestMatch ? bestMatch.title : '';
                                bestScore = score;
                                bestMatch = { index: entry.index, title: entry.header };
                            } else if (score > secondBestScore) {
                                secondBestScore = score;
                                secondBestTitle = entry.header;
                            }
                        }

                        if (!bestMatch || bestScore < 40) {
                            results.push({
                                id: actualFilename, version: meta.version || 1, status: 'error',
                                action: 'replace_entry_not_found',
                                error: `No ### entry matching "${item.replace_entry}" found (best score: ${Math.round(bestScore)}).`,
                                suggestion: 'Use append_to_section to create new entry instead.'
                            });
                            continue;
                        }

                        if (secondBestScore > 0 && bestScore < 100 && (bestScore - secondBestScore) < 15) {
                            results.push({
                                id: actualFilename, version: meta.version || 1, status: 'error',
                                action: 'replace_entry_ambiguous',
                                error: `Ambiguous match: "${bestMatch.title}" (score ${Math.round(bestScore)}) vs "${secondBestTitle}" (score ${Math.round(secondBestScore)}). Provide more specific title.`,
                                candidates: [bestMatch.title, secondBestTitle]
                            });
                            continue;
                        }

                        // Find entry end: next ### or next ## (major section)
                        const afterEntry = body.substring(bestMatch.index + bestMatch.title.length);
                        const nextEntryMatch = afterEntry.match(/\n(?=(?:\[\d{4}[^\]]*\]\s*)?### |\n## )/);
                        const entryEnd = nextEntryMatch
                            ? bestMatch.index + bestMatch.title.length + nextEntryMatch.index
                            : body.length;

                        const oldEntry = body.substring(bestMatch.index, entryEnd);
                        const now = new Date().toISOString().split('T')[0];
                        const cleanTitle = item.replace_entry.replace(/^###\s*/, '').trim();
                        const contentStartsWithHeader = /^###\s+/.test(content.trim());
                        const newEntry = contentStartsWithHeader
                            ? content.trim()
                            : `### ${cleanTitle} (updated ${now})\n${content}`;
                        const newBody = body.substring(0, bestMatch.index) + newEntry + '\n' + body.substring(entryEnd);

                        meta.version = (meta.version || 1) + 1;
                        meta.updated = new Date().toISOString();
                        atomicWriteFileSync(filepath, buildFrontmatter(meta) + newBody.trim() + '\n', 'utf8');
                        invalidateGetCache(actualFilename);
                        updateAllIndexes(actualFilename);

                        logger.info('ENTRY REPLACED', { filename: actualFilename, entry: bestMatch.title, old_size: oldEntry.length, new_size: newEntry.length, score: bestScore });
                        results.push({
                            id: actualFilename, version: meta.version, status: 'active',
                            action: 'entry_replaced',
                            matched_entry: bestMatch.title.substring(0, 100),
                            match_score: Math.round(bestScore),
                            old_size: oldEntry.length,
                            new_size: newEntry.length,
                            filepath
                        });
                        continue;
                    } finally {
                        releaseLock(filepath);
                    }
                } catch (replaceErr) {
                    results.push({ id: actualFilename, status: 'error', action: 'replace_entry_error', error: replaceErr.message, filepath });
                    continue;
                }
            }

            const result = saveRunbook(title, content, tags, options);

            // v7.0: Invalidate LRU cache + update FTS5 index
            if (result.action !== 'skipped_duplicate' && result.action !== 'skipped_near_duplicate' && result.action !== 'skipped_empty') {
                invalidateGetCache(result.id);
                updateAllIndexes(result.id);
            }

            // Auto-update MEMORY.md active target
            if (result.action !== 'skipped_duplicate' && result.action !== 'skipped_near_duplicate' && result.action !== 'skipped_empty') {
                updateActiveTarget(title, result.id);
            }

            const upsertResult = {
                id: result.id,
                version: result.version,
                status: 'active',
                action: result.action,
                filepath: result.filepath
            };

            results.push(upsertResult);

        } catch (err) {
            logger.error('Upsert runbook error', { error: err.message, title: item.title, trace_id: traceId });
            results.push({
                id: null,
                version: 0,
                status: 'error',
                error: err.message
            });
        }
    }

    // === POST-UPSERT INTELLIGENCE v7.4 ===
    // v7.4 FIX: Auto-save ke runbook LAIN DIMATIKAN by default.
    // ALASAN: Setiap upsert ke 1 runbook → 2-3 runbook lain ikut dimodifikasi
    // Dual-save sekarang HARUS eksplisit: auto_dual_save: true
    // v7.4 FIX #2: SKIP items yang BLOCKED — jangan run post-upsert pada item yang gagal save
    const reminders = [...contradictions]; // Include contradiction warnings from appendToSection
    const blockedIds = new Set(results.filter(r => r.status === 'blocked' || r.action === 'rejected').map(r => r.id));

    for (const item of items) {
        const title = (item.title || '').toLowerCase();
        const itemFilename = titleToFilename(item.title || '');

        // v7.4: SKIP blocked items — post-upsert hanya untuk item yang BERHASIL disimpan
        if (blockedIds.has(itemFilename)) continue;

        // v7.4: Auto-save HANYA jika eksplisit diminta
        if (item.auto_dual_save === true) {
            autoSaveUniversalError(item, results);
            const dualSaveResult = autoSaveTechnique(item);
            if (dualSaveResult) reminders.push(dualSaveResult);
        }

        // v7.5 Aturan 3: Suggest dual-save ketika content punya signal sukses/gagal tapi auto_dual_save off
        if (item.auto_dual_save !== true && title.startsWith('[runbook]')) {
            const c = (item.content || '').toLowerCase();
            const hasSuccess = /(?:berhasil|success|rce confirmed|shell obtained|root obtained)/i.test(c);
            const hasFailure = /(?:gagal|failed|blocked|patched|tidak berhasil)/i.test(c);
            if (hasSuccess || hasFailure) {
                reminders.push(`💡 DUAL-SAVE: Content mengandung ${hasSuccess ? 'KEBERHASILAN' : 'KEGAGALAN'}. Pertimbangkan auto_dual_save:true agar tersimpan juga di runbook universal.`);
            }
        }

        // v7.0: Check auto-invalidation (REMINDERS ONLY — tidak modifikasi file lain)
        const invalidationReminders = checkAutoInvalidation(item);
        reminders.push(...invalidationReminders);

        // REMINDER: Teknik gagal → harus simpan ke section GAGAL
        if (/(?:gagal|failed|blocked|denied|patched|timeout|unreachable|dead|rejected)/i.test(item.content || '')) {
            if (!/gagal/i.test((item.content || '').substring(0, 20))) {
                reminders.push('⚠️ FAILURE DETECTED: Content mengandung indikasi kegagalan. Pastikan disimpan di section ## GAGAL agar tidak diulangi.');
            }
        }

        // REMINDER: Credential baru → harus update RE-ENTRY CHECKLIST
        if (/(?:password|credential|ssh|webshell|tunnel|token|key|login)/i.test(item.content || '') && title.startsWith('[runbook]')) {
            reminders.push('⚠️ CREDENTIAL: Pastikan update section ## RE-ENTRY CHECKLIST dan ## LIVE STATUS dengan status ALIVE/DEAD terkini.');
        }

        // v7.5 Aturan 16: Warn jika content menyebut target berbeda dari runbook title
        if (title.startsWith('[runbook]')) {
            const runbookTarget = (item.title || '').replace(/^\[RUNBOOK\]\s*/i, '').trim().toLowerCase().split('.')[0];
            const contentLower = (item.content || '').toLowerCase();
            const otherTargetMatch = contentLower.match(/\[runbook\]\s*([a-z0-9.-]+)/i);
            if (otherTargetMatch) {
                const mentionedTarget = otherTargetMatch[1].split('.')[0];
                if (mentionedTarget !== runbookTarget && mentionedTarget.length >= 4) {
                    reminders.push(`⚠️ MISPLACED? Content menyebut "[RUNBOOK] ${otherTargetMatch[1]}" tapi disimpan di runbook "${runbookTarget}". Pastikan lokasi benar.`);
                }
            }
        }
    }

    const response = {
        upserted: results,
        meta: {
            trace_id: traceId,
            storage: 'filesystem',
            format: '.md'
        }
    };

    if (reminders.length > 0) {
        response.reminders = [...new Set(reminders)];
    }

    return response;
}

export default { definition, execute };
