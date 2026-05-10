/**
 * memory_verify v1.0 — Read-only pre-write verification tool
 * Checks: exists, duplicate, near-duplicate, contradiction, staleness
 * NEVER writes files, updates indexes, or changes active target.
 * @module mcp/tools/memory.verify
 */
import { readRunbook, searchRunbooks, parseFrontmatter, findSectionEnd, isMajorSection, RUNBOOKS_DIR } from '../../storage/files.js';
import { scrub } from '../../utils/scrubber.js';
import logger from '../../utils/logger.js';

const CONTRADICTION_PAIRS = [
    ['alive', 'dead'], ['dead', 'alive'],
    ['patched', 'vulnerable'], ['vulnerable', 'patched'],
    ['open', 'closed'], ['closed', 'open'],
    ['up', 'down'], ['running', 'stopped'],
    ['valid', 'invalid'], ['invalid', 'valid'],
    ['success', 'failed'], ['berhasil', 'gagal'], ['gagal', 'berhasil'],
    ['accessible', 'unreachable'], ['unreachable', 'accessible'],
    ['enabled', 'disabled'], ['root', 'unprivileged'],
];

function checkExact(body, claim) {
    return body.includes(claim.trim());
}

function checkNearDuplicate(body, claim) {
    const lines = claim.trim().split('\n').map(l => l.trim()).filter(l => l.length > 10);
    if (lines.length < 1) return { is: false, ratio: 0 };
    const bodyLower = body.toLowerCase();
    const matched = lines.filter(l => {
        const ll = l.toLowerCase();
        if (bodyLower.includes(ll)) return true;
        const core = ll.replace(/[\)\]\}\.\,\;\:]+$/, '').replace(/^[\-\*\#\s]+/, '').trim();
        return core.length >= 20 && bodyLower.includes(core);
    });
    const ratio = matched.length / lines.length;
    return { is: ratio >= 0.6, ratio: Math.round(ratio * 100) };
}

function checkContradiction(existingText, claim) {
    const claimLower = claim.toLowerCase();
    const existLower = existingText.toLowerCase();
    for (const [newState, existState] of CONTRADICTION_PAIRS) {
        if (claimLower.includes(newState) && existLower.includes(existState)) {
            return { found: true, detail: `Claim contains "${newState}" but existing data contains "${existState}"` };
        }
    }
    return { found: false, detail: null };
}

function checkStaleness(existingText) {
    const dateMatch = existingText.match(/\[(\d{4}-\d{2}-\d{2})\]/);
    if (!dateMatch) return { stale: false, detail: 'No date marker found — staleness unknown', verdict: 'unknown' };
    const entryDate = new Date(dateMatch[1]);
    const daysSince = Math.floor((Date.now() - entryDate.getTime()) / (1000 * 60 * 60 * 24));
    if (daysSince > 30) return { stale: true, detail: `Last dated entry: ${dateMatch[1]} (${daysSince} days ago)`, verdict: 'stale' };
    return { stale: false, detail: `Last dated entry: ${dateMatch[1]} (${daysSince} days ago)`, verdict: 'current' };
}

function findMatchingEntries(body, claim, maxEntries = 5) {
    const claimLower = claim.toLowerCase();
    const claimWords = claimLower.split(/[\s\-_.,]+/).filter(w => w.length >= 3);
    const entries = [];
    const entryRegex = /^### .+$/gm;
    let match;
    while ((match = entryRegex.exec(body)) !== null) {
        const title = match[0];
        const afterEntry = body.substring(match.index + title.length);
        const nextMatch = afterEntry.match(/\n(?=### |\n## )/);
        const end = nextMatch ? match.index + title.length + nextMatch.index : body.length;
        const entryText = body.substring(match.index, end);
        const entryLower = entryText.toLowerCase();
        const wordHits = claimWords.filter(w => entryLower.includes(w)).length;
        if (wordHits >= Math.max(1, Math.floor(claimWords.length * 0.3))) {
            entries.push({ title: title.replace(/^### /, ''), text: entryText, wordHits });
        }
    }
    entries.sort((a, b) => b.wordHits - a.wordHits);
    return entries.slice(0, maxEntries);
}

function detectSection(body, offset) {
    const before = body.substring(0, offset);
    const sections = before.split(/(?=^## )/m);
    const last = sections[sections.length - 1];
    const headerMatch = last.match(/^## (.+)/);
    return headerMatch ? headerMatch[1].trim() : 'UNKNOWN';
}

export const definition = {
    name: 'memory_verify',
    description: 'Read-only pre-write check: apakah data sudah ada, duplikat, bertentangan, atau stale? Gunakan SEBELUM memory_upsert untuk mencegah duplikat dan konflik. Tidak menulis file.',
    inputSchema: {
        type: 'object',
        properties: {
            target: { type: 'string', description: 'Target domain/name/runbook title. Jika kosong, search across all runbooks.' },
            claim: { type: 'string', description: 'Fact/data yang ingin dicek sebelum disimpan.' },
            check: { type: 'string', description: 'Jenis cek: exists, duplicate, contradiction, staleness, all (default: all)', enum: ['exists', 'duplicate', 'contradiction', 'staleness', 'all'] },
            section: { type: 'string', description: 'Batasi cek ke section tertentu (e.g. CREDENTIAL, EXPLOIT, GAGAL)' },
            limit: { type: 'number', description: 'Max matching entries to return (default: 5)' }
        },
        required: ['claim']
    }
};

export async function execute(params) {
    const { target, claim, check = 'all', section, limit = 5 } = params;

    if (!claim || claim.trim().length < 3) {
        return { ok: false, error: 'claim is required and must be at least 3 characters' };
    }

    try {
        let runbookId = null;
        let body = '';

        if (target) {
            const searchResults = searchRunbooks(target, { limit: 3 });
            if (searchResults.results && searchResults.results.length > 0) {
                runbookId = searchResults.results[0].id;
                const rb = readRunbook(runbookId);
                if (rb) body = rb.content || '';
            }
        } else {
            const searchResults = searchRunbooks(claim, { limit: 3 });
            if (searchResults.results && searchResults.results.length > 0) {
                runbookId = searchResults.results[0].id;
                const rb = readRunbook(runbookId);
                if (rb) body = rb.content || '';
            }
        }

        if (!body) {
            return {
                ok: true,
                verdict: 'new',
                target_id: null,
                check,
                evidence: { matching_entries: [], contradiction_detail: null, staleness_detail: null },
                recommended_action: { action: 'append', tool: 'memory_upsert', arguments: {} },
                meta: { read_only: true }
            };
        }

        let scopedBody = body;
        let scopedSection = null;
        if (section) {
            const sectionHeader = `## ${section}`;
            const regex = new RegExp(`^${sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'im');
            const m = regex.exec(body);
            if (m) {
                const end = findSectionEnd(body, m.index);
                scopedBody = body.substring(m.index, end);
                scopedSection = section;
            }
        }

        const results = {
            ok: true,
            verdict: 'new',
            target_id: runbookId,
            check,
            evidence: { matching_entries: [], contradiction_detail: null, staleness_detail: null },
            recommended_action: { action: 'append', tool: 'memory_upsert', arguments: {} },
            meta: { read_only: true }
        };

        const runChecks = check === 'all' ? ['exists', 'duplicate', 'contradiction', 'staleness'] : [check];

        for (const c of runChecks) {
            if (c === 'exists' || c === 'duplicate') {
                if (checkExact(scopedBody, claim)) {
                    results.verdict = 'duplicate';
                    results.recommended_action = { action: 'skip', tool: 'none', arguments: {} };
                    break;
                }
                const near = checkNearDuplicate(scopedBody, claim);
                if (near.is) {
                    results.verdict = 'near_duplicate';
                    results.evidence.matching_entries.push({
                        id: runbookId, title: '(near-duplicate detected)', section: scopedSection || 'file-wide',
                        snippet: scrub(claim.substring(0, 200)).text, similarity: near.ratio / 100, reason: 'near'
                    });
                    results.recommended_action = { action: 'skip', tool: 'none', arguments: {} };
                    break;
                }
            }

            if (c === 'contradiction') {
                const contra = checkContradiction(scopedBody, claim);
                if (contra.found) {
                    results.verdict = 'contradicts';
                    results.evidence.contradiction_detail = contra.detail;
                    results.recommended_action = {
                        action: 'supersede',
                        tool: 'memory_upsert',
                        arguments: { replace_entry: '(matching entry title)', content: claim }
                    };
                }
            }

            if (c === 'staleness') {
                const stale = checkStaleness(scopedBody);
                results.evidence.staleness_detail = stale.detail;
                if (stale.verdict === 'stale' && results.verdict === 'new') {
                    results.verdict = 'stale';
                    results.recommended_action = { action: 'update', tool: 'memory_upsert', arguments: {} };
                }
            }
        }

        if (results.verdict === 'new' || results.verdict === 'contradicts') {
            const matching = findMatchingEntries(scopedBody, claim, limit);
            for (const entry of matching) {
                results.evidence.matching_entries.push({
                    id: runbookId,
                    title: entry.title,
                    section: detectSection(body, body.indexOf(entry.text)),
                    snippet: scrub(entry.text.substring(0, 200)).text,
                    similarity: 0,
                    reason: results.verdict === 'contradicts' ? 'contradiction' : 'keyword_match'
                });
            }
            if (matching.length > 0 && results.verdict === 'new') {
                results.verdict = 'exists';
                results.recommended_action = { action: 'manual_review', tool: 'memory_upsert', arguments: {} };
            }
        }

        return results;
    } catch (err) {
        logger.error('memory_verify error', { error: err.message });
        return { ok: false, error: err.message, meta: { read_only: true } };
    }
}

export default { definition, execute };
