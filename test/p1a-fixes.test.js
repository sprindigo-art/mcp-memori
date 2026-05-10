import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// === P1-A.1: Cross-target auto-switch ===

describe('P1-A.1: Cross-target auto-switch prevention', () => {
    // Simulate the hook_auto_capture target switching logic (v8.7)
    function simulateTargetSwitch(toolName, detectedTarget, existingTarget) {
        const isUpsert = toolName.toLowerCase().includes('memory_upsert');
        if (isUpsert || !existingTarget) {
            return { switched: true, newTarget: detectedTarget, reason: isUpsert ? 'write_intent' : 'no_existing' };
        }
        if (detectedTarget !== existingTarget) {
            return { switched: false, newTarget: existingTarget, reason: 'reference_read_only' };
        }
        return { switched: false, newTarget: existingTarget, reason: 'same_target' };
    }

    it('memory_get on different target does NOT switch active target', () => {
        const result = simulateTargetSwitch('memory_get', 'targetB', 'targetA');
        assert.equal(result.switched, false);
        assert.equal(result.newTarget, 'targetA');
        assert.equal(result.reason, 'reference_read_only');
    });

    it('memory_upsert to different target DOES switch active target', () => {
        const result = simulateTargetSwitch('memory_upsert', 'targetB', 'targetA');
        assert.equal(result.switched, true);
        assert.equal(result.newTarget, 'targetB');
        assert.equal(result.reason, 'write_intent');
    });

    it('memory_get when no existing target sets target', () => {
        const result = simulateTargetSwitch('memory_get', 'targetA', null);
        assert.equal(result.switched, true);
        assert.equal(result.newTarget, 'targetA');
        assert.equal(result.reason, 'no_existing');
    });

    it('memory_get on same target does nothing', () => {
        const result = simulateTargetSwitch('memory_get', 'targetA', 'targetA');
        assert.equal(result.switched, false);
        assert.equal(result.newTarget, 'targetA');
        assert.equal(result.reason, 'same_target');
    });
});

// === P1-A.2: memory_forget dry_run ===

describe('P1-A.2: memory_forget dry_run', () => {
    function simulateDryRun(body, removeText, removeSection, dryRun) {
        let newBody = body;
        let removedChars = 0;

        if (removeText) {
            if (!body.includes(removeText)) return { ok: false, action: 'not_found' };
            const occ = body.split(removeText).length - 1;
            newBody = body.replace(removeText, '');
            removedChars = removeText.length;
        }

        if (removeSection) {
            const idx = newBody.indexOf(removeSection);
            if (idx === -1) return { ok: false, action: 'section_not_found' };
            const nextSection = newBody.indexOf('\n## ', idx + 1);
            const end = nextSection > -1 ? nextSection + 1 : newBody.length;
            removedChars += end - idx;
            newBody = newBody.substring(0, idx) + newBody.substring(end);
        }

        newBody = newBody.replace(/\n{3,}/g, '\n\n').trim();

        if (dryRun) {
            return {
                ok: true, action: 'dry_run_preview', dry_run: true,
                removed_chars: removedChars, remaining_length: newBody.length,
                preview_after: newBody.substring(0, 500)
            };
        }

        return { ok: true, action: 'partial_delete', removed_chars: removedChars, wrote_file: true };
    }

    it('dry_run returns preview without writing', () => {
        const body = '## RECON\ndata\n## CREDENTIAL\nsecret';
        const result = simulateDryRun(body, 'data', null, true);
        assert.equal(result.ok, true);
        assert.equal(result.action, 'dry_run_preview');
        assert.equal(result.dry_run, true);
        assert.ok(result.removed_chars > 0);
        assert.ok(!result.wrote_file);
    });

    it('non-dry_run actually writes', () => {
        const body = '## RECON\ndata\n## CREDENTIAL\nsecret';
        const result = simulateDryRun(body, 'data', null, false);
        assert.equal(result.action, 'partial_delete');
        assert.equal(result.wrote_file, true);
    });

    it('dry_run remove_section shows preview', () => {
        const body = '## RECON\ndata\n## CREDENTIAL\nsecret';
        const result = simulateDryRun(body, null, '## RECON', true);
        assert.equal(result.action, 'dry_run_preview');
        assert.ok(result.preview_after.includes('CREDENTIAL'));
        assert.ok(!result.preview_after.includes('RECON'));
    });
});

// === P1-A.3: UserPromptSubmit regex fix ===

describe('P1-A.3: UserPromptSubmit regex no false positives', () => {
    const codeExts = new Set(['js','ts','py','md','json','css','html','sh','cjs','mjs','jsx','tsx','yaml','yml','toml','xml','sql','log','txt','cfg','ini','conf','bak','tmp','lock']);
    const codeIds = new Set(['exit','now','log','env','err','pid','url','parse','then','call','bind','keys','map','set','get','push','pop','test','exec','join','trim','send','emit','once','pipe']);

    function hasTargetSignal(prompt) {
        const lower = prompt.toLowerCase();
        const domainMatch = lower.match(/[a-z0-9][-a-z0-9]*\.([a-z]{2,})(?:\.[a-z]{2,})?/);
        if (domainMatch && !codeExts.has(domainMatch[1]) && !codeIds.has(domainMatch[1])) return 'domain';
        if (/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(lower)) return 'ip';
        if (/cve-\d{4}-\d+/i.test(lower)) return 'cve';
        return false;
    }

    // Should NOT trigger
    it('hook_lib.js does not trigger', () => assert.equal(hasTargetSignal('Fix hook_lib.js'), false));
    it('memory.get.js does not trigger', () => assert.equal(hasTargetSignal('Read memory.get.js'), false));
    it('process.exit does not trigger', () => assert.equal(hasTargetSignal('Call process.exit'), false));
    it('Date.now does not trigger', () => assert.equal(hasTargetSignal('Use Date.now for timestamp'), false));
    it('package.json does not trigger', () => assert.equal(hasTargetSignal('Update package.json version'), false));
    it('README.md does not trigger', () => assert.equal(hasTargetSignal('Edit the README.md file'), false));
    it('src/server.js does not trigger', () => assert.equal(hasTargetSignal('Check src/server.js startup'), false));
    it('console.log does not trigger', () => assert.equal(hasTargetSignal('Add console.log for debug'), false));

    // SHOULD trigger
    it('target.com triggers as domain', () => assert.equal(hasTargetSignal('Check target.com'), 'domain'));
    it('sub.target.com triggers as domain', () => assert.equal(hasTargetSignal('Scan sub.target.com'), 'domain'));
    it('bappenas.go.id triggers as domain', () => assert.equal(hasTargetSignal('Check bappenas.go.id'), 'domain'));
    it('10.10.10.5 triggers as IP', () => assert.equal(hasTargetSignal('Scan host 10.10.10.5'), 'ip'));
    it('CVE-2024-1234 triggers as CVE', () => assert.equal(hasTargetSignal('Check CVE-2024-1234'), 'cve'));
});

// === P1-A.4: replace_entry ambiguity guard ===

describe('P1-A.4: replace_entry ambiguity guard', () => {
    function simulateReplaceEntry(entries, searchTitle) {
        const searchLower = searchTitle.replace(/^###\s*/, '').trim().toLowerCase();
        let bestMatch = null, bestScore = 0, secondBestScore = 0, secondBestTitle = '';

        for (const entry of entries) {
            const entryLower = entry.replace(/^### /, '').trim().toLowerCase();
            let score = 0;
            if (entryLower === searchLower) score = 100;
            else if (entryLower.includes(searchLower)) score = 80;
            else if (searchLower.includes(entryLower)) score = 70;
            else {
                const sw = searchLower.split(/[\s\-_.,]+/).filter(w => w.length >= 3);
                const ew = entryLower.split(/[\s\-_.,]+/).filter(w => w.length >= 3);
                const overlap = sw.filter(w => ew.some(e => e.includes(w) || w.includes(e))).length;
                if (sw.length > 0) score = (overlap / sw.length) * 60;
            }
            if (score > bestScore) {
                secondBestScore = bestScore;
                secondBestTitle = bestMatch ? bestMatch : '';
                bestScore = score;
                bestMatch = entry;
            } else if (score > secondBestScore) {
                secondBestScore = score;
                secondBestTitle = entry;
            }
        }

        if (!bestMatch || bestScore < 40) return { action: 'not_found' };
        if (secondBestScore > 0 && bestScore < 100 && (bestScore - secondBestScore) < 15) {
            return { action: 'ambiguous', best: bestMatch, second: secondBestTitle, gap: bestScore - secondBestScore };
        }
        return { action: 'matched', entry: bestMatch, score: bestScore };
    }

    it('ambiguous entries with close scores return error', () => {
        const entries = ['### SSH Credential 10.1.1.1', '### SSH Credential 10.1.1.2'];
        const result = simulateReplaceEntry(entries, 'SSH Credential');
        assert.equal(result.action, 'ambiguous');
    });

    it('exact match succeeds even with similar entries', () => {
        const entries = ['### SSH Credential 10.1.1.1', '### SSH Credential 10.1.1.2'];
        const result = simulateReplaceEntry(entries, 'SSH Credential 10.1.1.1');
        assert.equal(result.action, 'matched');
        assert.equal(result.entry, '### SSH Credential 10.1.1.1');
        assert.equal(result.score, 100);
    });

    it('clear contains match succeeds', () => {
        const entries = ['### MySQL Root Access', '### PostgreSQL Backup'];
        const result = simulateReplaceEntry(entries, 'MySQL Root');
        assert.equal(result.action, 'matched');
        assert.ok(result.entry.includes('MySQL'));
    });

    it('no match returns not_found', () => {
        const entries = ['### SSH Credential 10.1.1.1'];
        const result = simulateReplaceEntry(entries, 'Nonexistent Entry');
        assert.equal(result.action, 'not_found');
    });
});
