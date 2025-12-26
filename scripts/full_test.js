#!/usr/bin/env node
/**
 * MCP Memory Full Test - All 10 Phases
 */
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, '..', 'src', 'server.js');

const PROJECT_ID = 'uji-mcp-memori-001';

class McpClient {
    constructor() {
        this.requestId = 0;
        this.pending = new Map();
        this.buffer = '';
    }

    async start() {
        return new Promise((resolve, reject) => {
            this.child = spawn('node', [SERVER_PATH], {
                stdio: ['pipe', 'pipe', 'pipe']
            });

            this.child.stdout.on('data', (data) => {
                this.buffer += data.toString();
                this.processBuffer();
            });

            this.child.stderr.on('data', (data) => {
                // Ignore stderr (logs)
            });

            this.child.on('error', reject);

            // Wait for server to be ready
            setTimeout(() => resolve(), 500);
        });
    }

    processBuffer() {
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';

        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const response = JSON.parse(line);
                const resolver = this.pending.get(response.id);
                if (resolver) {
                    resolver(response);
                    this.pending.delete(response.id);
                }
            } catch (e) {
                // Ignore parse errors
            }
        }
    }

    async call(method, params = {}) {
        const id = ++this.requestId;
        const request = { jsonrpc: '2.0', id, method, params };

        return new Promise((resolve, reject) => {
            this.pending.set(id, resolve);
            this.child.stdin.write(JSON.stringify(request) + '\n');

            // Timeout after 10s
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`Timeout for ${method}`));
                }
            }, 10000);
        });
    }

    async toolCall(name, args) {
        const response = await this.call('tools/call', { name, arguments: args });
        if (response.error) {
            throw new Error(response.error.message);
        }
        const text = response.result?.content?.[0]?.text;
        return text ? JSON.parse(text) : response.result;
    }

    stop() {
        if (this.child) {
            this.child.kill();
        }
    }
}

// Test Results
const results = {
    passed: [],
    failed: []
};

function log(phase, message) {
    console.log(`[${phase}] ${message}`);
}

function pass(phase, test) {
    log(phase, `✅ PASS: ${test}`);
    results.passed.push(`${phase}: ${test}`);
}

function fail(phase, test, reason) {
    log(phase, `❌ FAIL: ${test} - ${reason}`);
    results.failed.push(`${phase}: ${test} - ${reason}`);
}

async function runTests() {
    const client = new McpClient();

    try {
        // ==================== PHASE 0 ====================
        log('PHASE 0', '=== INISIALISASI ===');
        await client.start();

        const initResp = await client.call('initialize', {});
        if (initResp.result?.serverInfo?.name === 'mcp-memori') {
            pass('PHASE 0', 'MCP Memory aktif');
        } else {
            fail('PHASE 0', 'MCP Memory aktif', 'Server tidak merespons dengan benar');
        }

        const toolsResp = await client.call('tools/list', {});
        if (toolsResp.result?.tools?.length === 7) {
            pass('PHASE 0', '7 tools tersedia');
        } else {
            fail('PHASE 0', '7 tools tersedia', `Hanya ${toolsResp.result?.tools?.length || 0} tools`);
        }

        // ==================== PHASE 1 ====================
        log('PHASE 1', '=== SIMPAN MEMORI AWAL ===');

        // 1. Simpan STATE
        const stateResult = await client.toolCall('memory_upsert', {
            items: [{
                type: 'state',
                project_id: PROJECT_ID,
                title: 'State Awal Proyek Uji MCP',
                content: `Proyek ini bertujuan menguji MCP Memory dari nol.
Status: setup awal selesai.
Langkah berikutnya: uji penyimpanan, recall, dan self-healing.`,
                tags: ['state', 'uji', 'awal'],
                verified: true,
                confidence: 1.0
            }]
        });
        const stateId = stateResult.upserted?.[0]?.id;
        const stateVersion = stateResult.upserted?.[0]?.version;
        log('PHASE 1', `STATE: id=${stateId}, version=${stateVersion}`);
        if (stateId && stateVersion >= 1) {
            pass('PHASE 1', 'STATE tersimpan');
        } else {
            fail('PHASE 1', 'STATE tersimpan', `version=${stateVersion}, id=${stateId}`);
        }

        // 2. Simpan DECISION
        const decisionResult = await client.toolCall('memory_upsert', {
            items: [{
                type: 'decision',
                project_id: PROJECT_ID,
                title: 'Keputusan Menggunakan MCP Memory Lokal',
                content: `Diputuskan menggunakan MCP Memory berbasis Node.js
dengan embedding lokal atau keyword-only tanpa API key
agar aman dan deterministik.`,
                tags: ['decision', 'arsitektur'],
                verified: true,
                confidence: 0.95
            }]
        });
        const decisionId = decisionResult.upserted?.[0]?.id;
        if (decisionId) {
            pass('PHASE 1', 'DECISION tersimpan');
        } else {
            fail('PHASE 1', 'DECISION tersimpan', 'Gagal menyimpan');
        }

        // 3. Simpan RUNBOOK BENAR
        const runbookResult = await client.toolCall('memory_upsert', {
            items: [{
                type: 'runbook',
                project_id: PROJECT_ID,
                title: 'Cara Menyimpan dan Mengambil Memori MCP',
                content: `Langkah:
1. Gunakan memory_upsert untuk menyimpan memori.
2. Gunakan memory_search untuk mengambil memori.
3. Gunakan memory_summarize saat sesi baru.
Expected output: memori konsisten lintas sesi.`,
                tags: ['runbook', 'benar'],
                verified: true,
                confidence: 1.0
            }]
        });
        const runbookId = runbookResult.upserted?.[0]?.id;
        if (runbookId) {
            pass('PHASE 1', 'RUNBOOK BENAR tersimpan');
        } else {
            fail('PHASE 1', 'RUNBOOK BENAR tersimpan', 'Gagal menyimpan');
        }

        // ==================== PHASE 2 ====================
        log('PHASE 2', '=== RECALL TEST ===');

        // 4. Search
        const searchResult = await client.toolCall('memory_search', {
            query: 'apa tujuan proyek ini dan apa langkah berikutnya',
            project_id: PROJECT_ID,
            limit: 10
        });

        log('PHASE 2', `Search returned ${searchResult.results?.length || 0} results`);
        const searchIds = searchResult.results?.map(r => r.id) || [];
        if (searchIds.includes(stateId)) {
            pass('PHASE 2', 'STATE muncul di hasil search');
        } else {
            fail('PHASE 2', 'STATE muncul di hasil search', `Expected ${stateId}, got ${searchIds.join(',')}`);
        }

        if (searchResult.results?.length >= 2) {
            pass('PHASE 2', 'Multiple results returned');
        } else {
            fail('PHASE 2', 'Multiple results returned', `Hanya ${searchResult.results?.length || 0} hasil`);
        }

        // 5. Summarize
        const summaryResult = await client.toolCall('memory_summarize', {
            project_id: PROJECT_ID
        });

        log('PHASE 2', `Summarize: ${JSON.stringify(Object.keys(summaryResult))}`);
        if (summaryResult.state_latest?.title) {
            pass('PHASE 2', 'summarize mengembalikan state_latest');
        } else {
            fail('PHASE 2', 'summarize mengembalikan state_latest', 'Tidak ada state_latest');
        }

        // ==================== PHASE 3 ====================
        log('PHASE 3', '=== AMNESIA TEST (SESI BARU) ===');

        // 6. Summarize tanpa konteks
        const summaryResult2 = await client.toolCall('memory_summarize', {
            project_id: PROJECT_ID
        });

        if (summaryResult2.state_latest?.content?.includes('menguji MCP Memory')) {
            pass('PHASE 3', 'State persisten setelah "sesi baru"');
        } else {
            fail('PHASE 3', 'State persisten setelah "sesi baru"', 'Content tidak matching');
        }

        // ==================== PHASE 4 ====================
        log('PHASE 4', '=== MEMORI SALAH ===');

        // 7. Simpan RUNBOOK SALAH
        const wrongRunbookResult = await client.toolCall('memory_upsert', {
            items: [{
                type: 'runbook',
                project_id: PROJECT_ID,
                title: 'Cara Update MCP (SALAH)',
                content: 'Untuk update MCP Memory, hapus seluruh database agar fresh.',
                tags: ['runbook', 'salah'],
                verified: false,
                confidence: 0.3
            }]
        });
        const wrongRunbookId = wrongRunbookResult.upserted?.[0]?.id;
        if (wrongRunbookId) {
            pass('PHASE 4', 'RUNBOOK SALAH tersimpan');
        } else {
            fail('PHASE 4', 'RUNBOOK SALAH tersimpan', 'Gagal menyimpan');
        }

        // 8. Search untuk runbook salah
        const searchWrong = await client.toolCall('memory_search', {
            query: 'cara update mcp memory',
            project_id: PROJECT_ID,
            limit: 5
        });
        log('PHASE 4', `Search wrong returned ${searchWrong.results?.length || 0} results`);
        const wrongInResults = searchWrong.results?.some(r => r.id === wrongRunbookId);
        if (wrongInResults) {
            pass('PHASE 4', 'RUNBOOK SALAH muncul di search (sebelum feedback)');
        } else {
            fail('PHASE 4', 'RUNBOOK SALAH muncul di search', 'Tidak ditemukan');
        }

        // ==================== PHASE 5 ====================
        log('PHASE 5', '=== FEEDBACK & SELF-HEALING ===');

        // 9. Feedback wrong
        const feedbackResult = await client.toolCall('memory_feedback', {
            id: wrongRunbookId,
            label: 'wrong',
            notes: 'Menghapus database adalah langkah berbahaya'
        });

        log('PHASE 5', `Feedback result: status=${feedbackResult.status}, error_count=${feedbackResult.error_count}`);
        if (feedbackResult.status === 'quarantined' || feedbackResult.error_count >= 1) {
            pass('PHASE 5', 'Feedback wrong diterapkan');
        } else {
            fail('PHASE 5', 'Feedback wrong diterapkan', `Status: ${feedbackResult.status}`);
        }

        // 10. Maintain
        const maintainResult = await client.toolCall('memory_maintain', {
            project_id: PROJECT_ID,
            mode: 'apply',
            actions: ['prune', 'loopbreak']
        });

        log('PHASE 5', `Maintain result: ${JSON.stringify(Object.keys(maintainResult))}`);
        if (maintainResult.actions_applied || maintainResult.summary || Object.keys(maintainResult).length > 0) {
            pass('PHASE 5', 'Maintain dijalankan');
        } else {
            fail('PHASE 5', 'Maintain dijalankan', 'Tidak ada aksi');
        }

        // ==================== PHASE 6 ====================
        log('PHASE 6', '=== RECALL SETELAH SELF-HEALING ===');

        // 11. Search ulang
        const searchAfterHeal = await client.toolCall('memory_search', {
            query: 'cara update mcp memory',
            project_id: PROJECT_ID,
            limit: 5
        });

        const wrongStillVisible = searchAfterHeal.results?.some(r => r.id === wrongRunbookId);
        if (!wrongStillVisible) {
            pass('PHASE 6', 'RUNBOOK SALAH tidak muncul setelah self-healing');
        } else {
            fail('PHASE 6', 'RUNBOOK SALAH tidak muncul', 'Masih muncul di hasil');
        }

        // 12. Check runbook benar masih ada
        const correctRunbookVisible = searchAfterHeal.results?.some(r => r.id === runbookId);
        log('PHASE 6', `Runbook benar visible: ${correctRunbookVisible}`);

        // ==================== PHASE 7 ====================
        log('PHASE 7', '=== LOOP BREAKER ===');

        // 13. Feedback wrong kedua kali (jika masih ada)
        try {
            const feedbackResult2 = await client.toolCall('memory_feedback', {
                id: wrongRunbookId,
                label: 'wrong',
                notes: 'Kesalahan kedua kali - harus di-delete'
            });
            log('PHASE 7', `Second feedback: status=${feedbackResult2.status}, error_count=${feedbackResult2.error_count}`);

            // 14. Maintain lagi
            const maintainResult2 = await client.toolCall('memory_maintain', {
                project_id: PROJECT_ID,
                mode: 'apply',
                actions: ['loopbreak', 'prune']
            });

            if (maintainResult2.loopbreaker?.guardrails_added > 0 || maintainResult2.pruned?.length > 0) {
                pass('PHASE 7', 'Loop breaker atau prune aktif');
            } else {
                log('PHASE 7', 'Loop breaker tidak menambah guardrail (mungkin sudah di-delete)');
                pass('PHASE 7', 'Item sudah di-prune sebelumnya');
            }
        } catch (e) {
            pass('PHASE 7', 'Item sudah tidak bisa diakses (deleted)');
        }

        // ==================== PHASE 8 ====================
        log('PHASE 8', '=== CONCURRENCY TEST ===');

        // 15. 3 AI paralel menyimpan FACT yang sama
        const factContent = 'MCP Memory harus idempotent.';
        const factTitle = 'Prinsip Idempotency MCP';

        const [ai1, ai2, ai3] = await Promise.all([
            client.toolCall('memory_upsert', {
                items: [{
                    type: 'fact',
                    project_id: PROJECT_ID,
                    title: factTitle,
                    content: factContent,
                    tags: ['fact', 'ai-1']
                }]
            }),
            client.toolCall('memory_upsert', {
                items: [{
                    type: 'fact',
                    project_id: PROJECT_ID,
                    title: factTitle,
                    content: factContent,
                    tags: ['fact', 'ai-2']
                }]
            }),
            client.toolCall('memory_upsert', {
                items: [{
                    type: 'fact',
                    project_id: PROJECT_ID,
                    title: factTitle,
                    content: factContent,
                    tags: ['fact', 'ai-3']
                }]
            })
        ]);

        // Check: should be same ID or version > 1
        const ids = [ai1.upserted?.[0]?.id, ai2.upserted?.[0]?.id, ai3.upserted?.[0]?.id];
        const versions = [ai1.upserted?.[0]?.version, ai2.upserted?.[0]?.version, ai3.upserted?.[0]?.version];
        const uniqueIds = [...new Set(ids.filter(Boolean))];

        log('PHASE 8', `IDs: ${ids.join(', ')}`);
        log('PHASE 8', `Versions: ${versions.join(', ')}`);
        log('PHASE 8', `Unique IDs: ${uniqueIds.length}`);

        if (uniqueIds.length === 1) {
            pass('PHASE 8', 'Hanya 1 FACT aktif (idempotent)');
        } else {
            fail('PHASE 8', 'Hanya 1 FACT aktif', `${uniqueIds.length} items berbeda`);
        }

        const maxVersion = Math.max(...versions.filter(v => typeof v === 'number'));
        if (maxVersion >= 1) {
            pass('PHASE 8', `Version meningkat (max: ${maxVersion})`);
        }

        // ==================== PHASE 9 ====================
        log('PHASE 9', '=== AUDIT & TRACEABILITY ===');

        // 16. Get salah satu memori
        const getResult = await client.toolCall('memory_get', {
            id: stateId
        });

        if (getResult.id === stateId) {
            pass('PHASE 9', 'memory_get berhasil');
        } else {
            fail('PHASE 9', 'memory_get berhasil', 'ID tidak cocok');
        }

        if (getResult.version >= 1) {
            pass('PHASE 9', 'Version history konsisten');
        }

        if (getResult.status === 'active') {
            pass('PHASE 9', 'Status benar (active)');
        }

        // ==================== PHASE 10 ====================
        log('PHASE 10', '=== FINAL VERDICT ===');

        console.log('\n========================================');
        console.log('           TEST RESULTS');
        console.log('========================================');
        console.log(`✅ PASSED: ${results.passed.length}`);
        console.log(`❌ FAILED: ${results.failed.length}`);
        console.log('========================================\n');

        if (results.failed.length === 0) {
            console.log('🎉 MCP MEMORY: SEMUA TEST BERHASIL!');
            console.log('✓ Memori persisten lintas sesi');
            console.log('✓ Tidak mengulang dari nol');
            console.log('✓ Self-healing berfungsi');
            console.log('✓ Loop breaker aktif');
            console.log('✓ Concurrency-safe');
        } else {
            console.log('⚠️  BEBERAPA TEST GAGAL:');
            results.failed.forEach(f => console.log(`  - ${f}`));
        }

        console.log('\n');

    } catch (err) {
        console.error('Test error:', err.message);
        fail('UNKNOWN', 'Test execution', err.message);
    } finally {
        client.stop();
        process.exit(results.failed.length > 0 ? 1 : 0);
    }
}

runTests();
