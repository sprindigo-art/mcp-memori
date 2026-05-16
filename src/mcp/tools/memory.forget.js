/**
 * memory.forget v6.2 — WAJIB baca runbook utuh dulu sebelum hapus
 * Menolak penghapusan jika belum membaca full content via memory_get
 * @module mcp/tools/memory.forget
 */
import { deleteRunbook, RUNBOOKS_DIR, parseFrontmatter, buildFrontmatter, atomicWriteFileSync, findSectionEnd, findSectionEndForDelete, isMajorSection } from '../../storage/files.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { invalidateGetCache } from './memory.get.js';
import { removeIndexEntry, updateIndexEntry } from '../../storage/searchIndex.js';
import { updateVectorEntry, removeVectorEntry } from '../../storage/vectorIndex.js';
import { updateGraphEntry, removeGraphEntry } from '../../storage/graphIndex.js';
import logger from '../../utils/logger.js';

// Track runbook yang sudah dibaca via memory_get
// readMode: 'full' | 'section' | 'sections_list'
const readConfirmations = new Map();

/**
 * Catat bahwa runbook sudah dibaca (dipanggil dari memory_get)
 * @param {string} id - Runbook filename
 * @param {string} mode - 'full' | 'section' | 'sections_list'
 * @param {number} charsRead - Jumlah karakter yang dibaca
 */
export function confirmRead(id, mode = 'full', charsRead = 0) {
    const existing = readConfirmations.get(id);
    const now = Date.now();

    if (readConfirmations.size > 100) {
        const tenMinutes = 10 * 60 * 1000;
        for (const [key, val] of readConfirmations) {
            if ((now - val.timestamp) >= tenMinutes) readConfirmations.delete(key);
        }
    }

    if (existing && existing.mode === 'full') {
        existing.timestamp = now;
        existing.charsRead = Math.max(existing.charsRead, charsRead);
        return;
    }

    // Accumulate reads — partial + sections can upgrade to enough for unlock
    const newChars = (existing ? existing.charsRead : 0) + charsRead;
    const newSections = existing ? (existing.sectionsRead || 0) : 0;
    const bestMode = mode === 'full' ? 'full' : (existing?.mode === 'partial' && mode === 'section') ? 'partial' : mode;

    readConfirmations.set(id, {
        timestamp: now,
        mode: bestMode,
        charsRead: newChars,
        sectionsRead: newSections,
        fullRead: mode === 'full' || (existing && existing.fullRead)
    });

    if (mode === 'section') {
        const entry = readConfirmations.get(id);
        entry.sectionsRead = (entry.sectionsRead || 0) + 1;
    }
}

/**
 * Cek apakah runbook sudah dibaca CUKUP untuk upsert dalam 10 menit terakhir
 * v8.8: Require FULL read (tanpa section param) atau paginated full read
 * Section-only read TIDAK lagi unlock — harus full read dulu
 */
export function hasBeenRead(id) {
    const entry = readConfirmations.get(id);
    if (!entry) return false;
    const tenMinutes = 10 * 60 * 1000;
    if ((Date.now() - entry.timestamp) >= tenMinutes) return false;

    // FULL read (entire content returned, no pagination) = OK
    if (entry.fullRead || entry.mode === 'full') return true;

    // PARTIAL read (paginated, hasMore=true) — AI called memory_get without section param
    // This means AI initiated a full read but runbook was too large for single response.
    // Allow unlock if AI received enough content to understand structure (>= 5KB).
    // For large runbooks (>50KB), memory_get returns overview only (no content) + unlock.
    if (entry.mode === 'partial') {
        if (entry.charsRead >= 5000) return true;
        if (entry.sectionsRead >= 2 && entry.charsRead > 3000) return true;
        return false;
    }

    // sections_list ALONE = NOT enough
    if (entry.mode === 'sections_list') return false;

    // Section-only read: require at least 3 different sections read with >2000 chars total
    if (entry.mode === 'section' && entry.sectionsRead >= 3 && entry.charsRead > 2000) return true;

    return false;
}

/**
 * Get read status for debug/logging
 */
export function getReadStatus(id) {
    const entry = readConfirmations.get(id);
    if (!entry) return { read: false, reason: 'never_read' };
    const tenMinutes = 10 * 60 * 1000;
    if ((Date.now() - entry.timestamp) >= tenMinutes) return { read: false, reason: 'expired' };
    const ok = hasBeenRead(id);
    return { read: ok, mode: entry.mode, charsRead: entry.charsRead, sectionsRead: entry.sectionsRead, fullRead: entry.fullRead, reason: ok ? 'ok' : 'insufficient_read' };
}

export const definition = {
    name: 'memory_forget',
    description: 'Hapus teks/section/file dari runbook. WAJIB memory_get(id) dulu sebelum forget — agar tidak menghapus yang valid.',
    inputSchema: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'Runbook filename' },
            reason: { type: 'string', description: 'Alasan penghapusan' },
            remove_text: { type: 'string', description: 'Teks spesifik yang dihapus (sisanya tetap). Jika muncul >1x, harus set remove_all:true atau gagal.' },
            remove_section: { type: 'string', description: 'Section ## HEADER yang dihapus (sisanya tetap)' },
            remove_all: { type: 'boolean', description: 'Jika true, hapus SEMUA occurrence remove_text. Default false (hanya boleh 1 occurrence).' },
            dry_run: { type: 'boolean', description: 'Jika true, tampilkan preview tanpa menulis/menghapus file. Gunakan untuk melihat efek delete sebelum commit.' }
        },
        required: ['id', 'reason']
    }
};

export async function execute(params) {
    const traceId = uuidv4();
    const { id, reason, remove_text: removeText, remove_section: removeSection, remove_all: removeAll = false, dry_run: dryRun = false } = params;

    if (!id) {
        return { ok: false, meta: { trace_id: traceId, error: 'id required' } };
    }

    // === HARD BLOCK: WAJIB baca utuh dulu sebelum hapus ===
    if (!hasBeenRead(id)) {
        return {
            ok: false,
            error: 'BLOCKED: Kamu BELUM membaca runbook ini. Jalankan memory_get({id:"' + id + '"}) dulu, baca UTUH isinya, baru boleh forget. Ini mencegah penghapusan content yang masih valid.',
            meta: { trace_id: traceId }
        };
    }

    try {
        const filepath = join(RUNBOOKS_DIR, id);
        if (!existsSync(filepath)) {
            return { ok: false, meta: { trace_id: traceId, error: 'Runbook not found' } };
        }

        // === PARTIAL DELETE ===
        if (removeText || removeSection) {
            const raw = readFileSync(filepath, 'utf8');
            const { meta, body } = parseFrontmatter(raw);
            let newBody = body;
            let removedChars = 0;

            if (removeText) {
                if (!body.includes(removeText)) {
                    return { ok: false, message: 'Teks tidak ditemukan di runbook. Pastikan exact match.', meta: { trace_id: traceId } };
                }
                const occurrences = body.split(removeText).length - 1;
                if (occurrences > 1 && !removeAll) {
                    return {
                        ok: false,
                        action: 'ambiguous_multiple_occurrences',
                        occurrences,
                        error: `Text found ${occurrences} times across runbook. Set remove_all:true to delete all, or provide more specific text to match exactly 1 occurrence.`,
                        meta: { trace_id: traceId }
                    };
                }
                newBody = removeAll ? body.replaceAll(removeText, '') : body.replace(removeText, '');
                removedChars = removeText.length * (removeAll ? occurrences : 1);
            }

            if (removeSection) {
                const sectionHeader = removeSection.startsWith('##') ? removeSection : `## ${removeSection}`;
                const escapedHeader = sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const headerRegex = new RegExp(`^${escapedHeader}(?:\\s*$|\\s+&)`, 'im');
                const headerMatch = headerRegex.exec(newBody);
                if (!headerMatch) {
                    return { ok: false, message: `Section "${removeSection}" tidak ditemukan.`, meta: { trace_id: traceId } };
                }
                const sectionStart = headerMatch.index;
                const sectionEnd = findSectionEndForDelete(newBody, sectionStart);
                const removedText = newBody.substring(sectionStart, sectionEnd);
                newBody = newBody.substring(0, sectionStart) + newBody.substring(sectionEnd);
                removedChars += removedText.length;
            }

            newBody = newBody.replace(/\n{3,}/g, '\n\n').trim();

            if (dryRun) {
                return {
                    ok: true, action: 'dry_run_preview', dry_run: true,
                    target_id: id, removed_chars: removedChars,
                    remaining_length: newBody.length, original_length: body.length,
                    preview_after: newBody.substring(0, 500),
                    meta: { trace_id: traceId }
                };
            }

            meta.updated = new Date().toISOString();
            meta.version = (meta.version || 1) + 1;
            meta.last_edit = `Partial delete: ${reason}`;

            atomicWriteFileSync(filepath, buildFrontmatter(meta) + newBody + '\n', 'utf8');
            invalidateGetCache(id);
            try { updateIndexEntry(id); } catch {}
            try { updateVectorEntry(id).catch(() => {}); } catch {}
            try { updateGraphEntry(id); } catch {}
            logger.info('PARTIAL DELETE after read confirmation', { id, removed_chars: removedChars, reason });

            return {
                ok: true,
                action: 'partial_delete',
                removed_chars: removedChars,
                remaining_length: newBody.length,
                version: meta.version,
                meta: { trace_id: traceId }
            };
        }

        // === FULL DELETE ===
        if (dryRun) {
            const raw = readFileSync(filepath, 'utf8');
            return {
                ok: true, action: 'dry_run_preview', dry_run: true,
                target_id: id, would_delete: 'entire_runbook',
                file_size: raw.length,
                meta: { trace_id: traceId }
            };
        }
        const deleted = deleteRunbook(id, reason);
        if (deleted) {
            readConfirmations.delete(id);
            invalidateGetCache(id);
            try { removeIndexEntry(id); } catch {}
            try { removeVectorEntry(id); } catch {}
            try { removeGraphEntry(id); } catch {}
        }

        return {
            ok: deleted,
            action: 'full_delete',
            affected: deleted ? [id] : [],
            meta: { trace_id: traceId }
        };

    } catch (err) {
        logger.error('memory_forget error', { error: err.message, trace_id: traceId });
        throw err;
    }
}

export default { definition, execute, confirmRead, getReadStatus };
