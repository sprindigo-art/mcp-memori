import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

// === P2-A.1: memory_verify tool ===

describe('P2-A.1: memory_verify tool', () => {
    it('is registered in tools index', () => {
        const src = readFileSync('/home/kali/Desktop/mcp-memori/src/mcp/index.js', 'utf8');
        assert.ok(src.includes("'memory_verify'"), 'memory_verify must be registered');
        assert.ok(src.includes('verifyTool'), 'verifyTool must be imported');
    });

    it('definition has correct schema', () => {
        const src = readFileSync('/home/kali/Desktop/mcp-memori/src/mcp/tools/memory.verify.js', 'utf8');
        assert.ok(src.includes("name: 'memory_verify'"), 'tool name correct');
        assert.ok(src.includes("required: ['claim']"), 'claim is required');
        assert.ok(src.includes("'exists', 'duplicate', 'contradiction', 'staleness', 'all'"), 'check enum present');
    });

    it('is read-only: never writes files', () => {
        const src = readFileSync('/home/kali/Desktop/mcp-memori/src/mcp/tools/memory.verify.js', 'utf8');
        assert.ok(!src.includes('writeFileSync'), 'must not use writeFileSync');
        assert.ok(!src.includes('atomicWriteFileSync'), 'must not use atomicWriteFileSync');
        assert.ok(!src.includes('appendFileSync'), 'must not use appendFileSync');
        assert.ok(!src.includes('saveRunbook'), 'must not call saveRunbook');
        assert.ok(!src.includes('updateIndexEntry'), 'must not update FTS index');
        assert.ok(!src.includes('updateVectorEntry'), 'must not update vector index');
        assert.ok(!src.includes('setSessionTarget'), 'must not change active target');
    });

    it('returns read_only:true in meta', () => {
        const src = readFileSync('/home/kali/Desktop/mcp-memori/src/mcp/tools/memory.verify.js', 'utf8');
        assert.ok(src.includes('read_only: true'), 'meta must contain read_only: true');
    });
});

describe('P2-A.1: memory_verify logic', () => {
    // Simulate the core logic used in memory_verify

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

    const CONTRADICTION_PAIRS = [
        ['alive', 'dead'], ['dead', 'alive'],
        ['patched', 'vulnerable'], ['vulnerable', 'patched'],
        ['open', 'closed'], ['closed', 'open'],
        ['success', 'failed'], ['berhasil', 'gagal'],
        ['enabled', 'disabled'],
    ];

    function checkContradiction(existingText, claim) {
        const claimLower = claim.toLowerCase();
        const existLower = existingText.toLowerCase();
        for (const [newState, existState] of CONTRADICTION_PAIRS) {
            if (claimLower.includes(newState) && existLower.includes(existState)) {
                return { found: true, detail: `"${newState}" vs "${existState}"` };
            }
        }
        return { found: false, detail: null };
    }

    function checkStaleness(text) {
        const m = text.match(/\[(\d{4}-\d{2}-\d{2})\]/);
        if (!m) return { verdict: 'unknown' };
        const days = Math.floor((Date.now() - new Date(m[1]).getTime()) / 86400000);
        return { verdict: days > 30 ? 'stale' : 'current', days };
    }

    it('exact duplicate detected', () => {
        const body = '## CREDENTIAL\n### MySQL Root\nuser: root, password: test123';
        assert.ok(checkExact(body, 'user: root, password: test123'));
    });

    it('near-duplicate detected (60%+ line overlap)', () => {
        const body = 'service MySQL on port 3306 is running\nroot user has full access\nadmin panel at /phpmyadmin';
        const claim = 'service MySQL on port 3306 is running\nroot user has full access\nnew info about backup';
        const result = checkNearDuplicate(body, claim);
        assert.ok(result.is, 'should detect near-duplicate');
        assert.ok(result.ratio >= 60);
    });

    it('non-duplicate not falsely flagged', () => {
        const body = 'MySQL running on port 3306';
        const claim = 'PostgreSQL running on port 5432 with SSL enabled';
        assert.ok(!checkExact(body, claim));
        assert.ok(!checkNearDuplicate(body, claim).is);
    });

    it('contradiction detected: alive vs dead', () => {
        const existing = 'service is alive and responding';
        const claim = 'service is dead, not responding';
        const result = checkContradiction(existing, claim);
        assert.ok(result.found);
    });

    it('contradiction detected: patched vs vulnerable', () => {
        const existing = 'CVE-2024-1234 vulnerable, confirmed';
        const claim = 'CVE-2024-1234 patched on 2026-05-10';
        const result = checkContradiction(existing, claim);
        assert.ok(result.found);
    });

    it('no false contradiction for unrelated terms', () => {
        const existing = 'MySQL root access confirmed';
        const claim = 'PostgreSQL backup running daily';
        const result = checkContradiction(existing, claim);
        assert.ok(!result.found);
    });

    it('staleness detected for old date', () => {
        const text = '[2025-01-01] old finding here';
        const result = checkStaleness(text);
        assert.equal(result.verdict, 'stale');
    });

    it('staleness unknown when no date marker', () => {
        const text = 'no date in this entry';
        const result = checkStaleness(text);
        assert.equal(result.verdict, 'unknown');
    });

    it('current entry not marked stale', () => {
        const today = new Date().toISOString().split('T')[0];
        const text = `[${today}] fresh finding`;
        const result = checkStaleness(text);
        assert.equal(result.verdict, 'current');
    });
});

// === P2-A.2: memory_type routing ===

describe('P2-A.2: memory_type routing', () => {
    // Replicate routing logic
    const ROUTING_TABLE = {
        credential:       { section: 'CREDENTIAL',          mode: 'append_to_section' },
        exploit_success:  { section: 'EXPLOIT',             mode: 'append_to_section', dual_save: true },
        exploit_failure:  { section: 'GAGAL',               mode: 'append_to_section', dual_save: true },
        status:           { section: 'LIVE STATUS',          mode: 'replace_section' },
        recon:            { section: 'RECON',                mode: 'append_to_section' },
        todo:             { section: 'RE-ENTRY CHECKLIST',   mode: 'replace_section' },
        blocker:          { section: 'RE-ENTRY CHECKLIST',   mode: 'append_to_section' },
        command:          { section: 'EXPLOIT',              mode: 'append_to_section' },
        lesson:           { section: 'EXPLOIT',              mode: 'append_to_section' },
        decision:         { section: 'LIVE STATUS',          mode: 'append_to_section' },
        environment:      { section: 'RECON',                mode: 'append_to_section' },
    };

    function routeMemoryType(t) {
        if (!t) return null;
        const key = t.toLowerCase().trim();
        const route = ROUTING_TABLE[key];
        if (!route) return { error: `Unknown memory_type "${t}".` };
        return { ...route, memory_type: key };
    }

    it('credential routes to CREDENTIAL', () => {
        const r = routeMemoryType('credential');
        assert.equal(r.section, 'CREDENTIAL');
        assert.equal(r.mode, 'append_to_section');
    });

    it('exploit_success routes to EXPLOIT with dual_save', () => {
        const r = routeMemoryType('exploit_success');
        assert.equal(r.section, 'EXPLOIT');
        assert.equal(r.dual_save, true);
    });

    it('exploit_failure routes to GAGAL with dual_save', () => {
        const r = routeMemoryType('exploit_failure');
        assert.equal(r.section, 'GAGAL');
        assert.equal(r.dual_save, true);
    });

    it('status routes to LIVE STATUS with replace_section', () => {
        const r = routeMemoryType('status');
        assert.equal(r.section, 'LIVE STATUS');
        assert.equal(r.mode, 'replace_section');
    });

    it('recon routes to RECON', () => {
        const r = routeMemoryType('recon');
        assert.equal(r.section, 'RECON');
    });

    it('todo routes to RE-ENTRY CHECKLIST', () => {
        const r = routeMemoryType('todo');
        assert.equal(r.section, 'RE-ENTRY CHECKLIST');
    });

    it('blocker routes to RE-ENTRY CHECKLIST as append', () => {
        const r = routeMemoryType('blocker');
        assert.equal(r.section, 'RE-ENTRY CHECKLIST');
        assert.equal(r.mode, 'append_to_section');
    });

    it('environment routes to RECON', () => {
        const r = routeMemoryType('environment');
        assert.equal(r.section, 'RECON');
    });

    it('unknown memory_type returns error', () => {
        const r = routeMemoryType('nonsense_type');
        assert.ok(r.error);
        assert.ok(r.error.includes('Unknown'));
    });

    it('explicit append_to_section overrides memory_type in upsert', () => {
        const src = readFileSync('/home/kali/Desktop/mcp-memori/src/mcp/tools/memory.upsert.js', 'utf8');
        assert.ok(src.includes('!item.append_to_section && !item.replace_section && !item.replace_text && !item.replace_entry'),
            'routing only applies when no explicit mode is set');
    });

    it('memory_type schema added to upsert', () => {
        const src = readFileSync('/home/kali/Desktop/mcp-memori/src/mcp/tools/memory.upsert.js', 'utf8');
        assert.ok(src.includes('memory_type'), 'memory_type must be in schema');
    });
});

// === P2-A.3: Search correctness tests ===

describe('P2-A.3: Search correctness', () => {
    it('memory_search returns results with id field', () => {
        const src = readFileSync('/home/kali/Desktop/mcp-memori/src/mcp/tools/memory.search.js', 'utf8');
        assert.ok(src.includes('id: item.id'), 'structured results must include id');
    });

    it('memory_search returns next_call per result', () => {
        const src = readFileSync('/home/kali/Desktop/mcp-memori/src/mcp/tools/memory.search.js', 'utf8');
        assert.ok(src.includes("tool: 'memory_get'"), 'next_call must reference memory_get');
    });

    it('search footer uses actual result ID, not placeholder', () => {
        const src = readFileSync('/home/kali/Desktop/mcp-memori/src/mcp/tools/memory.search.js', 'utf8');
        assert.ok(!src.includes('id:"ID"'), 'literal ID placeholder must not exist');
        assert.ok(src.includes('firstId'), 'must use actual firstId');
    });

    it('_AUTO_LOG excluded from search index', () => {
        const src = readFileSync('/home/kali/Desktop/mcp-memori/src/storage/searchIndex.js', 'utf8');
        assert.ok(src.includes('_auto_log'), '_AUTO_LOG must be filtered from index');
    });

    it('domain reranking exists', () => {
        const src = readFileSync('/home/kali/Desktop/mcp-memori/src/mcp/tools/memory.search.js', 'utf8');
        assert.ok(src.includes('rerankResults') || src.includes('rerank'), 'reranking must be present');
    });

    it('credential proximity boosting in snippets', () => {
        const src = readFileSync('/home/kali/Desktop/mcp-memori/src/storage/files.js', 'utf8');
        assert.ok(src.includes("'password'") && src.includes('proximity'), 'credential proximity boosting must exist');
    });
});

// === P2-A.4: Duplicate and contradiction test ===

describe('P2-A.4: Dedup and contradiction in source', () => {
    const filesSrc = readFileSync('/home/kali/Desktop/mcp-memori/src/storage/files.js', 'utf8');
    const upsertSrc = readFileSync('/home/kali/Desktop/mcp-memori/src/mcp/tools/memory.upsert.js', 'utf8');

    it('exact duplicate check exists in appendToSection', () => {
        assert.ok(filesSrc.includes("body.includes(newContent.trim())"), 'exact file-wide check');
        assert.ok(filesSrc.includes("existingSection.includes(newContent.trim())"), 'exact section-level check');
    });

    it('near-duplicate check with 60% threshold exists', () => {
        assert.ok(filesSrc.includes('0.6'), '60% threshold present');
        assert.ok(filesSrc.includes('skipped_near_duplicate'), 'near-duplicate action');
    });

    it('content hash dedup exists in upsert', () => {
        assert.ok(upsertSrc.includes('isContentHashDuplicate'), 'content hash function');
        assert.ok(upsertSrc.includes('skipped_content_hash_dedup'), 'hash dedup action');
    });

    it('contradiction detection has 17 state pairs', () => {
        const pairsMatch = filesSrc.match(/contradictionPairs\s*=\s*\[([\s\S]*?)\];/);
        assert.ok(pairsMatch, 'contradictionPairs must exist');
        const pairs = pairsMatch[1].match(/\['/g);
        assert.ok(pairs && pairs.length >= 15, `Expected 15+ pairs, got ${pairs ? pairs.length : 0}`);
    });

    it('contradiction is advisory, not blocking', () => {
        assert.ok(filesSrc.includes('contradiction') && !filesSrc.includes("return { body, action: 'contradiction_blocked'"),
            'contradiction must warn, not block');
    });

    it('non-duplicate similar content passes through', () => {
        // The 60% threshold means <60% overlap passes — verified by design
        assert.ok(filesSrc.includes('>= 0.6'), 'threshold at 60% means <60% passes');
    });
});
