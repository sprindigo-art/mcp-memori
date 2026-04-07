/**
 * memory.upsert v7.0 — File-based Runbook Storage with Intelligence Layer
 * ALL saves go to .md files. APPEND-ONLY: never delete valid content.
 * v7.0: Universal error tracking, technique auto-save, auto-invalidation
 * WAJIB memory_get dulu jika runbook SUDAH ADA — agar tahu isinya sebelum append
 * @module mcp/tools/memory.upsert
 */
import { saveRunbook, titleToFilename, findByTitle, RUNBOOKS_DIR, parseFrontmatter, buildFrontmatter, filterNoiseTags } from '../../storage/files.js';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { hasBeenRead, getReadStatus } from './memory.forget.js';
import { invalidateGetCache } from './memory.get.js';
import { updateIndexEntry } from '../../storage/searchIndex.js';
import logger from '../../utils/logger.js';

const AUTO_MEMORY_PATH = '/home/kali/.claude/projects/-home-kali-Desktop/memory/MEMORY.md';

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
                        replace_text: { type: 'string', description: 'Find this exact text in the runbook and replace it with content. Like Edit tool — surgical edit without replacing entire section. Text must be unique in the file.' }
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

            // Fallback: cari by frontmatter title (title beda sanitization → filename beda)
            if (!fileExists) {
                const matchedPath = findByTitle(title);
                if (matchedPath) {
                    filepath = matchedPath;
                    actualFilename = basename(matchedPath);
                    fileExists = true;
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
                        + `FIX: Jalankan memory_get({id:"${actualFilename}"}) tanpa section/sections_list untuk FULL read, `
                        + `ATAU memory_get({id:"...", sections_list:true}) + memory_get({id:"...", section:"RELEVANT"}) untuk partial read. `
                        + `Baru boleh upsert setelah benar-benar PAHAM isi runbook.`
                });
                continue;
            }

            // === REPLACE TEXT MODE: Edit spesifik — cari teks lama, ganti dengan teks baru ===
            // Sama seperti Edit tool — surgical edit tanpa replace seluruh section
            if (item.replace_text && fileExists) {
                try {
                    const raw = readFileSync(filepath, 'utf8');
                    const { meta, body } = parseFrontmatter(raw);
                    const oldText = item.replace_text;
                    const newText = content;

                    // Cek apakah old_text ada di body
                    const occurrences = body.split(oldText).length - 1;
                    if (occurrences === 0) {
                        results.push({
                            id: actualFilename,
                            version: meta.version || 1,
                            status: 'error',
                            action: 'replace_text_not_found',
                            error: `Text not found in runbook. Make sure replace_text matches exactly.`,
                            preview: oldText.substring(0, 100)
                        });
                        continue;
                    }
                    if (occurrences > 1) {
                        results.push({
                            id: actualFilename,
                            version: meta.version || 1,
                            status: 'error',
                            action: 'replace_text_ambiguous',
                            error: `Text found ${occurrences} times — must be unique. Provide more context to make it unique.`,
                            preview: oldText.substring(0, 100)
                        });
                        continue;
                    }

                    // Replace exactly once
                    const newBody = body.replace(oldText, newText);

                    // Auto-append changelog
                    const now = new Date().toISOString().split('T')[0];
                    const changelogEntry = `- ${now} v${(meta.version || 1) + 1}: replace_text (${oldText.length} → ${newText.length} chars)`;
                    const changelogHeader = '## _CHANGELOG';
                    let finalBody = newBody;
                    if (finalBody.includes(changelogHeader)) {
                        finalBody = finalBody.replace(changelogHeader, `${changelogHeader}\n${changelogEntry}`);
                    } else {
                        finalBody = finalBody.trim() + `\n\n${changelogHeader}\n${changelogEntry}\n`;
                    }

                    // Update metadata
                    const oldTags = Array.isArray(meta.tags) ? meta.tags : [];
                    meta.tags = filterNoiseTags([...new Set([...oldTags, ...tags.map(t => t.toLowerCase())])]);
                    meta.updated = new Date().toISOString();
                    meta.version = (meta.version || 1) + 1;

                    writeFileSync(filepath, buildFrontmatter(meta) + finalBody.trim() + '\n', 'utf8');

                    invalidateGetCache(actualFilename);
                    try { updateIndexEntry(actualFilename); } catch {}
                    updateActiveTarget(title, actualFilename);

                    logger.info('TEXT REPLACED', { filename: actualFilename, old_len: oldText.length, new_len: newText.length });

                    results.push({
                        id: actualFilename,
                        version: meta.version,
                        status: 'active',
                        action: 'text_replaced',
                        old_length: oldText.length,
                        new_length: newText.length,
                        filepath
                    });
                    continue;
                } catch (replaceErr) {
                    logger.error('Replace text error', { error: replaceErr.message, filename: actualFilename });
                }
            }

            // === REPLACE SECTION MODE: Ganti section yang sudah tidak valid ===
            if (item.replace_section && fileExists) {
                try {
                    const raw = readFileSync(filepath, 'utf8');
                    const { meta, body } = parseFrontmatter(raw);
                    const sectionHeader = item.replace_section.startsWith('##') ? item.replace_section : `## ${item.replace_section}`;
                    const sectionRegex = new RegExp(
                        `${sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?(?=\\n## |$)`, 'i'
                    );
                    const match = body.match(sectionRegex);

                    let newBody;
                    if (match) {
                        // Replace existing section
                        newBody = body.replace(sectionRegex, `${sectionHeader}\n${content}\n\n`);
                        logger.info('SECTION REPLACED', { filename: actualFilename, section: item.replace_section, old_size: match[0].length, new_size: content.length });

                        // Auto-append changelog entry (APPEND-ONLY — never replaced)
                        const now = new Date().toISOString().split('T')[0];
                        const changelogEntry = `- ${now} v${(meta.version || 1) + 1}: replaced ## ${item.replace_section} (${match[0].length} → ${content.length} chars)`;
                        const changelogHeader = '## _CHANGELOG';
                        if (newBody.includes(changelogHeader)) {
                            newBody = newBody.replace(changelogHeader, `${changelogHeader}\n${changelogEntry}`);
                        } else {
                            newBody = newBody.trim() + `\n\n${changelogHeader}\n${changelogEntry}\n`;
                        }
                    } else {
                        // Section not found → append
                        newBody = body.trim() + `\n\n${sectionHeader}\n${content}\n`;
                        logger.info('SECTION NOT FOUND, APPENDED', { filename: actualFilename, section: item.replace_section });
                    }

                    // Merge tags (import filterNoiseTags from files.js)
                    const oldTags = Array.isArray(meta.tags) ? meta.tags : [];
                    meta.tags = filterNoiseTags([...new Set([...oldTags, ...tags.map(t => t.toLowerCase())])]);
                    meta.updated = new Date().toISOString();
                    meta.version = (meta.version || 1) + 1;

                    writeFileSync(filepath, buildFrontmatter(meta) + newBody.trim() + '\n', 'utf8');

                    // v7.0: Invalidate cache + update index after replace_section
                    invalidateGetCache(actualFilename);
                    try { updateIndexEntry(actualFilename); } catch {}

                    // Auto-update MEMORY.md active target
                    updateActiveTarget(title, actualFilename);

                    results.push({
                        id: actualFilename,
                        version: meta.version,
                        status: 'active',
                        action: match ? 'section_replaced' : 'section_appended',
                        section: item.replace_section,
                        filepath
                    });
                    continue;
                } catch (replaceErr) {
                    logger.error('Replace section error', { error: replaceErr.message, filename: actualFilename });
                    // Fall through to normal append
                }
            }

            const result = saveRunbook(title, content, tags, options);

            // v7.0: Invalidate LRU cache + update FTS5 index
            if (result.action !== 'skipped_duplicate' && result.action !== 'skipped_empty') {
                invalidateGetCache(result.id);
                try { updateIndexEntry(result.id); } catch {}
            }

            // Auto-update MEMORY.md active target
            if (result.action !== 'skipped_duplicate' && result.action !== 'skipped_empty') {
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

    // === POST-UPSERT INTELLIGENCE (v7.0) ===
    const reminders = [];

    for (const item of items) {
        const title = (item.title || '').toLowerCase();

        // v7.0: AUTO-SAVE universal errors (cross-target learning)
        autoSaveUniversalError(item, results);

        // v7.1: Auto dual-save technique to [TEKNIK] runbook (not just reminder)
        const dualSaveResult = autoSaveTechnique(item);
        if (dualSaveResult) reminders.push(dualSaveResult);

        // v7.0: Check auto-invalidation (PATCHED/DEAD/VERSION detection)
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
