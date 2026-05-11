/**
 * memory_verify v1.0 — Read-only pre-write verification tool
 * Checks: exists, duplicate, near-duplicate, contradiction, staleness
 * NEVER writes files, updates indexes, or changes active target.
 * @module mcp/tools/memory.verify
 */
import { readRunbook, searchRunbooks, parseFrontmatter, findSectionEnd, isMajorSection, titleToFilename, RUNBOOKS_DIR } from '../../storage/files.js';
import { scrub } from '../../utils/scrubber.js';
import { readdirSync } from 'fs';
import { basename } from 'path';
import logger from '../../utils/logger.js';

const CONTRADICTION_PAIRS = [
    ['alive', 'dead'], ['dead', 'alive'],
    ['active', 'dead'], ['dead', 'active'],
    ['active', 'inactive'], ['inactive', 'active'],
    ['patched', 'vulnerable'], ['vulnerable', 'patched'],
    ['open', 'closed'], ['closed', 'open'],
    ['up', 'down'], ['down', 'up'],
    ['running', 'stopped'], ['stopped', 'running'],
    ['valid', 'invalid'], ['invalid', 'valid'],
    ['success', 'failed'], ['failed', 'success'],
    ['berhasil', 'gagal'], ['gagal', 'berhasil'],
    ['failed', 'berhasil'], ['berhasil', 'failed'],
    ['success', 'gagal'], ['gagal', 'success'],
    ['accessible', 'unreachable'], ['unreachable', 'accessible'],
    ['enabled', 'disabled'], ['disabled', 'enabled'],
    ['online', 'offline'], ['offline', 'online'],
    ['root', 'unprivileged'], ['unprivileged', 'root'],
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

function resolveTarget(target) {
    const files = readdirSync(RUNBOOKS_DIR).filter(f => f.endsWith('.md'));
    const targetLower = target.toLowerCase().trim();

    // A. Exact filename match (e.g. "RUNBOOK_target.md" or "TEKNIK_foo.md")
    if (files.includes(target)) {
        return { id: target, method: 'exact_filename' };
    }
    const withMd = target.endsWith('.md') ? target : target + '.md';
    if (files.includes(withMd)) {
        return { id: withMd, method: 'exact_filename' };
    }

    // B. Normalized title→filename match
    const fromTitle = titleToFilename(`[RUNBOOK] ${target}`);
    if (files.includes(fromTitle)) {
        return { id: fromTitle, method: 'title_to_filename' };
    }
    const fromTeknik = titleToFilename(`[TEKNIK] ${target}`);
    if (files.includes(fromTeknik)) {
        return { id: fromTeknik, method: 'title_to_filename_teknik' };
    }

    // C. Substring match on filename — RUNBOOK preferred over TEKNIK
    const runbookMatches = [];
    const teknikMatches = [];
    for (const f of files) {
        const fLower = f.toLowerCase();
        if (fLower.includes(targetLower.replace(/[\s.]+/g, '_'))) {
            if (fLower.startsWith('runbook_')) runbookMatches.push(f);
            else if (fLower.startsWith('teknik_')) teknikMatches.push(f);
            else runbookMatches.push(f);
        }
    }

    // D. RUNBOOK match wins over TEKNIK for domain/IP/target-like inputs
    if (runbookMatches.length === 1) {
        return { id: runbookMatches[0], method: 'filename_substring_runbook' };
    }
    if (runbookMatches.length > 1) {
        return { id: runbookMatches[0], method: 'filename_substring_runbook_first', candidates: runbookMatches.slice(0, 3) };
    }

    // E. TEKNIK only if no RUNBOOK match and target explicitly looks like technique
    const isTeknikQuery = targetLower.startsWith('teknik') || targetLower.includes('[teknik]');
    if (teknikMatches.length === 1 && (isTeknikQuery || runbookMatches.length === 0)) {
        return { id: teknikMatches[0], method: 'filename_substring_teknik' };
    }
    if (teknikMatches.length > 1 && isTeknikQuery) {
        return { id: teknikMatches[0], method: 'filename_substring_teknik_first', candidates: teknikMatches.slice(0, 3) };
    }

    // F. Fallback to searchRunbooks — but prefer RUNBOOK over TEKNIK in results
    const searchResults = searchRunbooks(target, { limit: 5 });
    if (searchResults.results && searchResults.results.length > 0) {
        const runbookHit = searchResults.results.find(r => r.id.toLowerCase().startsWith('runbook_'));
        if (runbookHit) {
            return { id: runbookHit.id, method: 'search_prefer_runbook' };
        }
        return { id: searchResults.results[0].id, method: 'search_fallback' };
    }

    return { id: null, method: 'not_found' };
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
        let resolutionMethod = 'none';

        if (target) {
            const resolved = resolveTarget(target);
            runbookId = resolved.id;
            resolutionMethod = resolved.method;
            if (runbookId) {
                const rb = readRunbook(runbookId);
                if (rb) body = rb.content || '';
            }
        } else {
            const searchResults = searchRunbooks(claim, { limit: 3 });
            if (searchResults.results && searchResults.results.length > 0) {
                runbookId = searchResults.results[0].id;
                resolutionMethod = 'search_by_claim';
                const rb = readRunbook(runbookId);
                if (rb) body = rb.content || '';
            }
        }

        if (!body) {
            return {
                ok: true,
                verdict: 'new',
                target_id: null,
                target_resolution: { method: resolutionMethod },
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
            target_resolution: { method: resolutionMethod },
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
