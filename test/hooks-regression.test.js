/**
 * Regression tests for hook fixes (target switching + GAGAL injection)
 * Run: node --test test/hooks-regression.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractTargetFromToolCall } from '../scripts/hooks/hook_lib.js';

describe('extractTargetFromToolCall — focus vs reference', () => {

    it('memory_get FULL runbook read (no section) → returns target', () => {
        const result = extractTargetFromToolCall('mcp__mcp-memori__memory_get', {
            id: 'RUNBOOK_iwk.md'
        });
        assert.equal(result, 'iwk');
    });

    it('memory_get FULL runbook with domain → returns target', () => {
        const result = extractTargetFromToolCall('mcp__mcp-memori__memory_get', {
            id: 'RUNBOOK_customerportal.iwk.com.my.md'
        });
        assert.equal(result, 'customerportal.iwk.com.my');
    });

    it('memory_get with SECTION param → returns null (reference read)', () => {
        const result = extractTargetFromToolCall('mcp__mcp-memori__memory_get', {
            id: 'RUNBOOK_canalmap.bangkok.go.th.md',
            section: 'EXPLOIT'
        });
        assert.equal(result, null,
            'Section read must NOT switch target');
    });

    it('memory_get with SEARCH param → returns null (reference read)', () => {
        const result = extractTargetFromToolCall('mcp__mcp-memori__memory_get', {
            id: 'RUNBOOK_target.com.md',
            section: 'CREDENTIAL',
            search: '10.1.1.5'
        });
        assert.equal(result, null,
            'Search read must NOT switch target');
    });

    it('memory_get with sections_list → returns null (navigation only)', () => {
        const result = extractTargetFromToolCall('mcp__mcp-memori__memory_get', {
            id: 'RUNBOOK_target.com.md',
            sections_list: true
        });
        assert.equal(result, null,
            'sections_list must NOT switch target');
    });

    it('memory_get on TEKNIK → returns null', () => {
        const result = extractTargetFromToolCall('mcp__mcp-memori__memory_get', {
            id: 'TEKNIK_XSS_Bypass.md'
        });
        assert.equal(result, null,
            'TEKNIK reads must NEVER switch target');
    });

    it('memory_get on UNIFIED → returns null', () => {
        const result = extractTargetFromToolCall('mcp__mcp-memori__memory_get', {
            id: 'RUNBOOK__AUTO_LOG_UNIFIED.md'
        });
        assert.equal(result, null);
    });

    it('memory_upsert to RUNBOOK → returns target (always focus)', () => {
        const result = extractTargetFromToolCall('mcp__mcp-memori__memory_upsert', {
            items: [{ title: '[RUNBOOK] iwk.com.my', content: 'data' }]
        });
        assert.equal(result, 'iwk.com.my');
    });

    it('memory_upsert to TEKNIK → returns null', () => {
        const result = extractTargetFromToolCall('mcp__mcp-memori__memory_upsert', {
            items: [{ title: '[TEKNIK] SQLi Union', content: 'data' }]
        });
        assert.equal(result, null);
    });

    it('unknown tool → returns null', () => {
        const result = extractTargetFromToolCall('Bash', { command: 'whoami' });
        assert.equal(result, null);
    });

    it('no input → returns null', () => {
        assert.equal(extractTargetFromToolCall(null, null), null);
        assert.equal(extractTargetFromToolCall('memory_get', null), null);
    });
});

describe('session start GAGAL injection (structural test)', () => {

    it('GAGAL section titles extracted correctly', () => {
        const gagalSection = `## GAGAL
### SSRF via PDF generator — blocked by WAF
Detail about failure

[2026-06-01] ### CVE-2024-1234 vCenter RCE — patched v8.0.3
Exact error output here

### Webshell upload .php — extension filtered
More detail`;

        const titleMatches = gagalSection.match(/^(?:\[\d{4}[^\]]*\]\s*)?###\s+.+$/gm) || [];
        const titles = titleMatches.slice(-10).map(t =>
            t.replace(/^\[\d{4}[^\]]*\]\s*/, '').replace(/^###\s+/, '').substring(0, 90)
        );

        assert.equal(titles.length, 3);
        assert.ok(titles[0].includes('SSRF via PDF'));
        assert.ok(titles[1].includes('CVE-2024-1234'));
        assert.ok(titles[2].includes('Webshell upload'));
    });

    it('empty GAGAL section → no titles', () => {
        const gagalSection = `## GAGAL\n`;
        const titleMatches = gagalSection.match(/^(?:\[\d{4}[^\]]*\]\s*)?###\s+.+$/gm) || [];
        assert.equal(titleMatches.length, 0);
    });

    it('no GAGAL section → empty array', () => {
        const gagal = '';
        const gagalTitles = gagal ? (gagal.match(/^(?:\[\d{4}[^\]]*\]\s*)?###\s+.+$/gm) || []) : [];
        assert.equal(gagalTitles.length, 0);
    });

    it('GAGAL with >10 entries → only last 10', () => {
        let gagalSection = '## GAGAL\n';
        for (let i = 1; i <= 15; i++) {
            gagalSection += `### Technique ${i} — failed\nDetails ${i}\n\n`;
        }
        const titleMatches = gagalSection.match(/^(?:\[\d{4}[^\]]*\]\s*)?###\s+.+$/gm) || [];
        const titles = titleMatches.slice(-10);
        assert.equal(titles.length, 10);
        assert.ok(titles[0].includes('Technique 6'));
        assert.ok(titles[9].includes('Technique 15'));
    });
});
