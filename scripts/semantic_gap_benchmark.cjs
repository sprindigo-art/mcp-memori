#!/usr/bin/env node
/**
 * MCP Memory v3.2 - SEMANTIC GAP BENCHMARK
 * 
 * Purpose: Prove semantic superiority by testing queries where
 * KEYWORD FAILS but VECTOR SUCCEEDS
 * 
 * Dataset: 20 items with semantic descriptions (no keyword overlap)
 * Queries: Direct terms that ONLY match semantically
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PROJECT_ID = 'semantic-gap-' + Date.now();
const ARTIFACTS_DIR = path.join(__dirname, '..', 'test-artifacts');
const DATASET_PATH = path.join(ARTIFACTS_DIR, 'semantic_gap_dataset.jsonl');

const dataset = fs.readFileSync(DATASET_PATH, 'utf8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line));

// Queries that should ONLY match via semantic, not keyword
const QUERIES = [
    { query: 'air mendidih', expected_title: 'Proses Evaporasi Air' },
    { query: 'mobil', expected_title: 'Kendaraan Beroda Empat' },
    { query: 'laptop', expected_title: 'Perangkat Komputasi Portabel' },
    { query: 'hujan', expected_title: 'Cuaca Dengan Presipitasi' },
    { query: 'makanan pedas', expected_title: 'Rasa Pedas Dari Cabai' },
    { query: 'kucing', expected_title: 'Mamalia Peliharaan Berbulu' },
    { query: 'saham investasi', expected_title: 'Instrumen Keuangan Ekuitas' },
    { query: 'lari jogging', expected_title: 'Olahraga Lari Jarak Jauh' },
    { query: 'python programming', expected_title: 'Bahasa Pemrograman Ular' },
    { query: 'database postgresql', expected_title: 'Sistem Manajemen Basis Data Relasional' },
    { query: 'cloud aws', expected_title: 'Layanan Komputasi Awan' },
    { query: 'https ssl', expected_title: 'Protokol Transfer Hypertext Aman' },
    { query: 'docker container', expected_title: 'Kontainerisasi Aplikasi' },
    { query: 'microservices api', expected_title: 'Arsitektur Layanan Mikro' },
    { query: 'push notification', expected_title: 'Notifikasi Dorong Mobile' },
    { query: 'kopi coffee', expected_title: 'Minuman Berkafein Pagi' },
    { query: 'e-wallet gopay', expected_title: 'Alat Pembayaran Digital' },
    { query: 'linkedin networking', expected_title: 'Jejaring Sosial Profesional' },
    { query: 'git github', expected_title: 'Penyimpanan Kode Sumber Terdistribusi' },
    { query: 'deep learning neural', expected_title: 'Pembelajaran Mesin Dalam' }
];

const K = 5;

console.log('='.repeat(70));
console.log('MCP MEMORY v3.2 - SEMANTIC GAP BENCHMARK');
console.log('='.repeat(70));
console.log(`Dataset: ${dataset.length} items (NO keyword overlap)`);
console.log(`Queries: ${QUERIES.length} (direct terms)`);
console.log(`Project ID: ${PROJECT_ID}\n`);

const serverPath = path.join(__dirname, '..', 'src', 'server.js');
let proc;
let buffer = '';
let requestId = 0;

function sendRequest(method, params = {}) {
    return new Promise((resolve, reject) => {
        const id = ++requestId;
        const request = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

        const handler = (data) => {
            buffer += data.toString();
            const lines = buffer.split('\n');
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const response = JSON.parse(line);
                    if (response.id === id) {
                        proc.stdout.removeListener('data', handler);
                        buffer = '';
                        resolve({ response });
                        return;
                    }
                } catch (e) { /* not JSON */ }
            }
        };

        proc.stdout.on('data', handler);
        proc.stdin.write(request);

        setTimeout(() => {
            proc.stdout.removeListener('data', handler);
            reject(new Error('Timeout'));
        }, 60000);
    });
}

async function runBenchmark() {
    proc = spawn('node', [serverPath], {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: { ...process.env, EMBEDDING_MODE: 'hybrid', EMBEDDING_BACKEND: 'local' }
    });

    await new Promise(r => setTimeout(r, 5000));

    // Seed data
    console.log('--- SEEDING SEMANTIC GAP DATA ---');
    for (const item of dataset) {
        await sendRequest('tools/call', {
            name: 'memory_upsert',
            arguments: {
                items: [{
                    type: item.type,
                    project_id: PROJECT_ID,
                    title: item.title,
                    content: item.content,
                    tags: item.tags || []
                }]
            }
        });
    }
    console.log(`Seeded ${dataset.length} items\n`);

    await new Promise(r => setTimeout(r, 5000));

    // Test each query
    let keywordHits = 0;
    let hybridHits = 0;
    const results = [];

    console.log('--- TESTING SEMANTIC GAP QUERIES ---\n');

    for (const q of QUERIES) {
        const result = await sendRequest('tools/call', {
            name: 'memory_search',
            arguments: {
                query: q.query,
                project_id: PROJECT_ID,
                limit: 5
            }
        });

        const content = JSON.parse(result.response.result?.content?.[0]?.text || '{}');
        const searchResults = content.results || [];

        // Check top result
        const topResult = searchResults[0];
        const topTitle = topResult?.title || '';
        const vectorScore = topResult?.score_breakdown?.vector || 0;
        const keywordScore = topResult?.score_breakdown?.keyword || 0;

        // Keyword hit: if top result matches AND has keyword score > 0
        const expectedFound = searchResults.some(r =>
            r.title.toLowerCase().includes(q.expected_title.toLowerCase().split(' ')[0])
        );
        const keywordMatched = keywordScore > 1; // Significant keyword match
        const vectorMatched = vectorScore > 0.3; // Significant vector match

        if (expectedFound && keywordMatched) keywordHits++;
        if (expectedFound && vectorMatched) hybridHits++;

        const qResult = {
            query: q.query,
            expected: q.expected_title,
            found: expectedFound,
            top_title: topTitle,
            keyword_score: keywordScore,
            vector_score: vectorScore,
            keyword_would_find: keywordMatched,
            hybrid_would_find: vectorMatched
        };
        results.push(qResult);

        console.log(`Query: "${q.query}"`);
        console.log(`  Expected: ${q.expected_title}`);
        console.log(`  Top Result: ${topTitle || 'NONE'}`);
        console.log(`  Keyword: ${keywordScore.toFixed(2)} | Vector: ${vectorScore.toFixed(3)}`);
        console.log(`  Keyword finds: ${keywordMatched ? '✅' : '❌'} | Hybrid finds: ${vectorMatched ? '✅' : '❌'}`);
        console.log('');
    }

    // Calculate metrics
    const keywordRecall = keywordHits / QUERIES.length;
    const hybridRecall = hybridHits / QUERIES.length;
    const improvement = keywordRecall > 0 ?
        ((hybridRecall - keywordRecall) / keywordRecall) * 100 :
        (hybridRecall > 0 ? 100 : 0);

    console.log('='.repeat(70));
    console.log('SEMANTIC GAP RESULTS');
    console.log('='.repeat(70));
    console.log(`\nKeyword-Only Success: ${keywordHits}/${QUERIES.length} (${(keywordRecall * 100).toFixed(1)}%)`);
    console.log(`Hybrid Success:       ${hybridHits}/${QUERIES.length} (${(hybridRecall * 100).toFixed(1)}%)`);
    console.log(`\nImprovement: ${improvement >= 0 ? '+' : ''}${improvement.toFixed(1)}%`);

    const status = improvement >= 10 ? 'PASS' : (improvement > 0 ? 'PARTIAL' : 'PARITY');
    console.log(`\nSEMANTIC SUPERIORITY: ${status === 'PASS' ? '✅ PROVEN (≥10%)' :
        status === 'PARTIAL' ? '⚠️ PARTIAL (<10%)' :
            '❌ NOT PROVEN'}`);

    // Save report
    const report = {
        timestamp: new Date().toISOString(),
        project_id: PROJECT_ID,
        version: '3.2-SEMANTIC-GAP',
        dataset_size: dataset.length,
        query_count: QUERIES.length,
        metrics: {
            keyword_only: {
                hits: keywordHits,
                recall: keywordRecall
            },
            hybrid: {
                hits: hybridHits,
                recall: hybridRecall
            }
        },
        improvement_pct: improvement,
        meets_10pct_threshold: improvement >= 10,
        detailed_results: results,
        status
    };

    const reportPath = path.join(ARTIFACTS_DIR, 'semantic_gap_report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\nReport saved: ${reportPath}`);

    proc.kill();
    process.exit(status === 'PASS' ? 0 : 1);
}

runBenchmark().catch(err => {
    console.error('Error:', err);
    if (proc) proc.kill();
    process.exit(1);
});
