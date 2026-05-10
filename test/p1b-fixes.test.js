import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

// === P1-B.1: Stop hook uses atomicWriteFileSync ===

describe('P1-B.1: Stop hook atomic write', () => {
    const src = readFileSync('/home/kali/Desktop/mcp-memori/scripts/hooks/hook_session_stop.js', 'utf8');

    it('imports atomicWriteFileSync from files.js', () => {
        assert.ok(src.includes('atomicWriteFileSync'), 'Must import atomicWriteFileSync');
    });

    it('uses atomicWriteFileSync for finalContent write', () => {
        assert.ok(src.includes('atomicWriteFileSync(filepath, finalContent'), 'Must use atomicWriteFileSync for write');
    });

    it('does NOT use raw writeFileSync for finalContent', () => {
        assert.ok(!src.includes("wfs(filepath, finalContent"), 'Must not use raw wfs/writeFileSync');
        assert.ok(!src.includes("writeFileSync: wfs"), 'Must not import writeFileSync as wfs');
    });

    it('SESSION LOG logic still present', () => {
        assert.ok(src.includes('SESSION LOG'), 'SESSION LOG section handling must remain');
    });

    it('acquireLock/releaseLock still present', () => {
        assert.ok(src.includes('acquireLock(filepath)'), 'Lock must be acquired');
        assert.ok(src.includes('releaseLock(filepath)'), 'Lock must be released in finally');
    });
});

// === P1-B.2: Dead parameters removed ===

describe('P1-B.2: Dead parameters removed from schemas', () => {
    const search = readFileSync('/home/kali/Desktop/mcp-memori/src/mcp/tools/memory.search.js', 'utf8');
    const list = readFileSync('/home/kali/Desktop/mcp-memori/src/mcp/tools/memory.list.js', 'utf8');
    const stats = readFileSync('/home/kali/Desktop/mcp-memori/src/mcp/tools/memory.stats.js', 'utf8');

    it('memory_search: no project_id in required', () => {
        assert.ok(!search.includes("required: ['query', 'project_id']"), 'project_id must not be required');
        assert.ok(search.includes("required: ['query']"), 'Only query should be required');
    });

    it('memory_search: dead params removed from schema', () => {
        const schema = search.substring(search.indexOf('inputSchema'), search.indexOf('inputSchema') + 800);
        assert.ok(!schema.includes('types'), 'types must be removed');
        assert.ok(!schema.includes('override_quarantine'), 'override_quarantine must be removed');
        assert.ok(!schema.includes('allow_relations'), 'allow_relations must be removed');
        assert.ok(!schema.includes('full_content'), 'full_content must be removed');
    });

    it('memory_list: no project_id required, dead params removed', () => {
        assert.ok(!list.includes("required: ['project_id']"), 'project_id must not be required');
        const schema = list.substring(list.indexOf('inputSchema'), list.indexOf('inputSchema') + 600);
        assert.ok(!schema.includes('types'), 'types must be removed');
        assert.ok(!schema.includes("'Ignored"), 'Ignored params must be removed');
    });

    it('memory_stats: dead params removed', () => {
        assert.ok(!stats.includes('sections'), 'sections must be removed');
    });

    it('execute functions tolerate extra project_id from old clients', () => {
        // execute() destructures only what it needs — extra params in `params` object are harmlessly ignored by JS
        assert.ok(search.includes('execute(params)'), 'search execute takes params object');
        assert.ok(list.includes('execute(params)'), 'list execute takes params object');
    });
});

// === P1-B.3: Structured output for memory_search ===

describe('P1-B.3: memory_search structured output', () => {
    const search = readFileSync('/home/kali/Desktop/mcp-memori/src/mcp/tools/memory.search.js', 'utf8');
    const server = readFileSync('/home/kali/Desktop/mcp-memori/src/server.js', 'utf8');

    it('memory_search returns _raw with structured results', () => {
        assert.ok(search.includes('_raw:'), '_raw must be in return value');
        assert.ok(search.includes('structuredResults'), 'Must build structuredResults');
    });

    it('structured results contain id, title, score, snippet, next_call', () => {
        assert.ok(search.includes('id: item.id'), 'Must include id');
        assert.ok(search.includes('title: item.title'), 'Must include title');
        assert.ok(search.includes('score: item.score'), 'Must include score');
        assert.ok(search.includes('snippet: item.snippet'), 'Must include snippet');
        assert.ok(search.includes('next_call'), 'Must include next_call');
    });

    it('next_call contains memory_get tool reference', () => {
        assert.ok(search.includes("tool: 'memory_get'"), 'next_call must reference memory_get');
        assert.ok(search.includes('arguments: { id: item.id }'), 'next_call must include id argument');
    });

    it('server.js passes _raw as structuredContent', () => {
        assert.ok(server.includes('structuredContent'), 'server must handle structuredContent');
        assert.ok(server.includes('toolResult?._raw'), 'server must check for _raw');
    });
});

// === P1-B.4: memory_search footer guidance ===

describe('P1-B.4: memory_search footer uses actual IDs', () => {
    const search = readFileSync('/home/kali/Desktop/mcp-memori/src/mcp/tools/memory.search.js', 'utf8');

    it('footer does NOT contain literal memory_get({id:"ID"})', () => {
        assert.ok(!search.includes('id:"ID"'), 'Literal "ID" placeholder must be removed');
    });

    it('footer uses actual first result ID', () => {
        assert.ok(search.includes('firstId'), 'Must extract firstId from results');
        assert.ok(search.includes('id:"${firstId}"'), 'Footer must use firstId');
    });

    it('next page hint does NOT contain project_id', () => {
        assert.ok(!search.includes('project_id:"..."'), 'Next page must not reference project_id');
    });
});
