/**
 * memory.forget v6.2 — WAJIB baca runbook utuh dulu sebelum hapus
 * Menolak penghapusan jika belum membaca full content via memory_get
 * @module mcp/tools/memory.forget
 */
import { deleteRunbook, RUNBOOKS_DIR, parseFrontmatter, buildFrontmatter } from '../../storage/files.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { invalidateGetCache } from './memory.get.js';
import { removeIndexEntry, updateIndexEntry } from '../../storage/searchIndex.js';
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

    if (existing && existing.mode === 'full') {
        // Already fully read — just update timestamp
        existing.timestamp = now;
        existing.charsRead = Math.max(existing.charsRead, charsRead);
        return;
    }

    readConfirmations.set(id, {
        timestamp: now,
        mode,
        charsRead,
        sectionsRead: existing ? existing.sectionsRead : 0,
        fullRead: mode === 'full' || (existing && existing.fullRead)
    });

    // Upgrade: sections_list + section read = partial understanding
    if (existing && mode === 'section') {
        const entry = readConfirmations.get(id);
        entry.sectionsRead = (entry.sectionsRead || 0) + 1;
    }
}

/**
 * Cek apakah runbook sudah dibaca CUKUP untuk upsert dalam 10 menit terakhir
 * Requirement: FULL read ATAU (sections_list + minimal 1 section content read)
 */
export function hasBeenRead(id) {
    const entry = readConfirmations.get(id);
    if (!entry) return false;
    const tenMinutes = 10 * 60 * 1000;
    if ((Date.now() - entry.timestamp) >= tenMinutes) return false;

    // FULL read = OK
    if (entry.fullRead || entry.mode === 'full') return true;

    // sections_list ALONE = NOT enough (hanya lihat heading)
    if (entry.mode === 'sections_list' && (!entry.sectionsRead || entry.sectionsRead < 1)) return false;

    // section read with content = OK (sudah baca real content)
    if (entry.mode === 'section' && entry.charsRead > 100) return true;

    // sections_list + at least 1 section content = OK
    if (entry.sectionsRead >= 1 && entry.charsRead > 100) return true;

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
            remove_text: { type: 'string', description: 'Teks spesifik yang dihapus (sisanya tetap)' },
            remove_section: { type: 'string', description: 'Section ## HEADER yang dihapus (sisanya tetap)' }
        },
        required: ['id', 'reason']
    }
};

export async function execute(params) {
    const traceId = uuidv4();
    const { id, reason, remove_text: removeText, remove_section: removeSection } = params;

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
                newBody = body.replace(removeText, '');
                removedChars = removeText.length;
            }

            if (removeSection) {
                const sectionHeader = removeSection.startsWith('##') ? removeSection : `## ${removeSection}`;
                const sectionRegex = new RegExp(
                    `${sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?(?=\\n## |$)`, 'i'
                );
                const match = newBody.match(sectionRegex);
                if (!match) {
                    return { ok: false, message: `Section "${removeSection}" tidak ditemukan.`, meta: { trace_id: traceId } };
                }
                newBody = newBody.replace(sectionRegex, '');
                removedChars += match[0].length;
            }

            newBody = newBody.replace(/\n{3,}/g, '\n\n').trim();
            meta.updated = new Date().toISOString();
            meta.version = (meta.version || 1) + 1;
            meta.last_edit = `Partial delete: ${reason}`;

            writeFileSync(filepath, buildFrontmatter(meta) + newBody + '\n', 'utf8');
            invalidateGetCache(id);
            try { updateIndexEntry(id); } catch {}
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
        const deleted = deleteRunbook(id, reason);
        if (deleted) {
            readConfirmations.delete(id);
            invalidateGetCache(id);
            try { removeIndexEntry(id); } catch {}
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
