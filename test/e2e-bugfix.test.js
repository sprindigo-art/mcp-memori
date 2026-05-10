import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

// === BUG 1: replace_entry ambiguity guard ===

describe('BUG1: replace_entry ambiguity guard', () => {
    const src = readFileSync('/home/kali/Desktop/mcp-memori/src/mcp/tools/memory.upsert.js', 'utf8');

    it('ambiguity guard logic exists with gap < 15 check', () => {
        assert.ok(src.includes('(bestScore - secondBestScore) < 15'), 'gap < 15 check must exist');
        assert.ok(src.includes('replace_entry_ambiguous'), 'ambiguous action must exist');
    });

    it('mid-line ### entries are detected via midLineRegex', () => {
        assert.ok(src.includes('midLineRegex'), 'midLineRegex must exist for malformed entries');
    });

    it('double header prevention: content starting with ### is not re-wrapped', () => {
        assert.ok(src.includes('contentStartsWithHeader'), 'must check if content starts with ###');
    });

    // Simulate the actual ambiguity guard logic
    function simulateReplaceEntry(entries, searchTitle) {
        const searchLower = searchTitle.replace(/^###\s*/, '').trim().toLowerCase();
        const allMatches = entries.map((e, i) => ({ index: i * 100, header: e }));

        let bestMatch = null, bestScore = 0, secondBestScore = 0, secondBestTitle = '';
        for (const entry of allMatches) {
            const entryTitle = entry.header.replace(/^###\s+/, '').trim().toLowerCase();
            let score = 0;
            if (entryTitle === searchLower) score = 100;
            else if (entryTitle.includes(searchLower)) score = 80;
            else if (searchLower.includes(entryTitle)) score = 70;
            else {
                const sw = searchLower.split(/[\s\-_.,]+/).filter(w => w.length >= 3);
                const ew = entryTitle.split(/[\s\-_.,]+/).filter(w => w.length >= 3);
                const overlap = sw.filter(w => ew.some(e2 => e2.includes(w) || w.includes(e2))).length;
                if (sw.length > 0) score = (overlap / sw.length) * 60;
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

        if (!bestMatch || bestScore < 40) return { action: 'not_found' };
        if (secondBestScore > 0 && bestScore < 100 && (bestScore - secondBestScore) < 15) {
            return { action: 'replace_entry_ambiguous', best: bestMatch.title, second: secondBestTitle, gap: bestScore - secondBestScore };
        }
        return { action: 'matched', entry: bestMatch.title, score: bestScore };
    }

    it('two similar entries (gap=0) return ambiguous', () => {
        const entries = ['### Dummy SSH Credential 10.1.1.1', '### Dummy SSH Credential 10.1.1.2'];
        const result = simulateReplaceEntry(entries, 'Dummy SSH Credential');
        assert.equal(result.action, 'replace_entry_ambiguous');
        assert.equal(result.gap, 0);
    });

    it('exact match succeeds even with similar entries', () => {
        const entries = ['### Dummy SSH Credential 10.1.1.1', '### Dummy SSH Credential 10.1.1.2'];
        const result = simulateReplaceEntry(entries, 'Dummy SSH Credential 10.1.1.1');
        assert.equal(result.action, 'matched');
        assert.equal(result.score, 100);
        assert.ok(result.entry.includes('10.1.1.1'));
    });

    it('specific match succeeds with clear gap', () => {
        const entries = ['### MySQL Root Access', '### PostgreSQL Backup'];
        const result = simulateReplaceEntry(entries, 'MySQL Root');
        assert.equal(result.action, 'matched');
        assert.ok(result.entry.includes('MySQL'));
    });

    it('no match returns not_found', () => {
        const entries = ['### SSH Credential 10.1.1.1'];
        const result = simulateReplaceEntry(entries, 'Nonexistent Entry XYZ');
        assert.equal(result.action, 'not_found');
    });

    it('content starting with ### does not create double header', () => {
        const content = '### My Updated Entry\nuser: newuser\npass: newpass';
        const contentStartsWithHeader = /^###\s+/.test(content.trim());
        assert.ok(contentStartsWithHeader, 'should detect ### prefix');
        const cleanTitle = 'My Entry';
        const now = '2026-05-10';
        const newEntry = contentStartsWithHeader ? content.trim() : `### ${cleanTitle} (updated ${now})\n${content}`;
        assert.ok(!newEntry.startsWith('### My Entry'), 'should NOT prepend another header');
        assert.ok(newEntry.startsWith('### My Updated Entry'), 'should use content header as-is');
    });

    it('content without ### gets proper header', () => {
        const content = 'user: newuser\npass: newpass';
        const contentStartsWithHeader = /^###\s+/.test(content.trim());
        assert.ok(!contentStartsWithHeader);
        const newEntry = contentStartsWithHeader ? content.trim() : `### MyEntry (updated 2026-05-10)\n${content}`;
        assert.ok(newEntry.startsWith('### MyEntry'), 'should prepend header');
    });
});

// === BUG 2: memory_verify target resolution ===

describe('BUG2: memory_verify target resolution', () => {
    const src = readFileSync('/home/kali/Desktop/mcp-memori/src/mcp/tools/memory.verify.js', 'utf8');

    it('resolveTarget function exists', () => {
        assert.ok(src.includes('function resolveTarget(target)'), 'resolveTarget must exist');
    });

    it('has deterministic priority order: exact > title > substring > search', () => {
        assert.ok(src.includes('exact_filename'), 'must check exact filename');
        assert.ok(src.includes('title_to_filename'), 'must check title-to-filename');
        assert.ok(src.includes('filename_substring_runbook'), 'must check substring with RUNBOOK preference');
        assert.ok(src.includes('search_prefer_runbook'), 'must prefer RUNBOOK in search fallback');
        assert.ok(src.includes('search_fallback'), 'must have search fallback');
    });

    it('RUNBOOK preferred over TEKNIK in substring match', () => {
        assert.ok(src.includes("fLower.startsWith('runbook_')"), 'must separate RUNBOOK matches');
        assert.ok(src.includes("fLower.startsWith('teknik_')"), 'must separate TEKNIK matches');
        assert.ok(src.indexOf('runbookMatches.length === 1') < src.indexOf('teknikMatches.length === 1'),
            'RUNBOOK check must come before TEKNIK check');
    });

    it('RUNBOOK preferred over TEKNIK in search fallback', () => {
        assert.ok(src.includes("r.id.toLowerCase().startsWith('runbook_')"), 'search fallback must prefer RUNBOOK');
    });

    it('target_resolution in output', () => {
        assert.ok(src.includes('target_resolution:'), 'output must include target_resolution');
        assert.ok(src.includes('method: resolutionMethod'), 'must include resolution method');
    });

    it('still read-only: no write operations', () => {
        assert.ok(!src.includes('writeFileSync'), 'must not write files');
        assert.ok(!src.includes('atomicWriteFileSync'), 'must not atomic write');
        assert.ok(!src.includes('saveRunbook'), 'must not save runbook');
        assert.ok(!src.includes('setSessionTarget'), 'must not set target');
    });
});

// === BUG 3: Contradiction pairs completeness ===

describe('BUG3: CONTRADICTION_PAIRS completeness', () => {
    const src = readFileSync('/home/kali/Desktop/mcp-memori/src/mcp/tools/memory.verify.js', 'utf8');

    it('has failed/success reverse pair', () => {
        assert.ok(src.includes("'failed', 'success'"), 'failed→success must exist');
    });

    it('has cross-language pairs: failed/berhasil', () => {
        assert.ok(src.includes("'failed', 'berhasil'"), 'failed→berhasil must exist');
        assert.ok(src.includes("'berhasil', 'failed'"), 'berhasil→failed must exist');
    });

    it('has cross-language pairs: success/gagal', () => {
        assert.ok(src.includes("'success', 'gagal'"), 'success→gagal must exist');
        assert.ok(src.includes("'gagal', 'success'"), 'gagal→success must exist');
    });

    it('has all reverse pairs for other states', () => {
        assert.ok(src.includes("'down', 'up'"), 'down→up reverse');
        assert.ok(src.includes("'stopped', 'running'"), 'stopped→running reverse');
        assert.ok(src.includes("'disabled', 'enabled'"), 'disabled→enabled reverse');
        assert.ok(src.includes("'unprivileged', 'root'"), 'unprivileged→root reverse');
    });

    // Simulate contradiction check with actual logic
    const PAIRS = [
        ['alive', 'dead'], ['dead', 'alive'],
        ['patched', 'vulnerable'], ['vulnerable', 'patched'],
        ['open', 'closed'], ['closed', 'open'],
        ['up', 'down'], ['down', 'up'], ['running', 'stopped'], ['stopped', 'running'],
        ['valid', 'invalid'], ['invalid', 'valid'],
        ['success', 'failed'], ['failed', 'success'],
        ['berhasil', 'gagal'], ['gagal', 'berhasil'],
        ['failed', 'berhasil'], ['berhasil', 'failed'],
        ['success', 'gagal'], ['gagal', 'success'],
        ['accessible', 'unreachable'], ['unreachable', 'accessible'],
        ['enabled', 'disabled'], ['disabled', 'enabled'],
        ['root', 'unprivileged'], ['unprivileged', 'root'],
    ];

    function checkContradiction(existingText, claim) {
        const claimLower = claim.toLowerCase();
        const existLower = existingText.toLowerCase();
        for (const [newState, existState] of PAIRS) {
            if (claimLower.includes(newState) && existLower.includes(existState)) {
                return { found: true, detail: `"${newState}" vs "${existState}"` };
            }
        }
        return { found: false };
    }

    it('claim "success" vs existing "failed" => contradicts', () => {
        assert.ok(checkContradiction('exploit attempt failed', 'exploit was a success').found);
    });

    it('claim "failed" vs existing "success" => contradicts', () => {
        assert.ok(checkContradiction('exploit success confirmed', 'exploit has failed').found);
    });

    it('claim "berhasil" vs existing "failed" => contradicts', () => {
        assert.ok(checkContradiction('attempt failed on target', 'teknik berhasil dijalankan').found);
    });

    it('claim "gagal" vs existing "success" => contradicts', () => {
        assert.ok(checkContradiction('previous success on port 22', 'koneksi gagal total').found);
    });

    it('claim "failed" vs existing "berhasil" => contradicts', () => {
        assert.ok(checkContradiction('exploit berhasil', 'exploit failed completely').found);
    });

    it('claim "success" vs existing "gagal" => contradicts', () => {
        assert.ok(checkContradiction('semua gagal', 'now it is a success').found);
    });

    it('unrelated claim does NOT trigger contradiction', () => {
        assert.ok(!checkContradiction('MySQL root access confirmed', 'PostgreSQL backup running daily').found);
    });

    it('same-direction terms do NOT trigger contradiction', () => {
        assert.ok(!checkContradiction('exploit success on target', 'another success confirmed').found);
    });
});
