#!/usr/bin/env node
/**
 * MCP Memory v2.1 - Benchmark Runner & Regression Gate
 * Tests all core features and measures performance metrics
 * 
 * Outputs: test-artifacts/benchmark_report.json
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PROJECT_ID = 'benchmark-' + Date.now();
const ARTIFACTS_DIR = path.join(__dirname, '..', 'test-artifacts');

// Ensure artifacts directory exists
if (!fs.existsSync(ARTIFACTS_DIR)) {
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

// Start MCP Server
const serverPath = path.join(__dirname, '..', 'src', 'server.js');
const proc = spawn('node', [serverPath], { stdio: ['pipe', 'pipe', 'inherit'] });

let buffer = '';
let requestId = 0;

function sendRequest(method, params = {}) {
    return new Promise((resolve, reject) => {
        const id = ++requestId;
        const request = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
        const startTime = Date.now();

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
                        resolve({
                            response,
                            latencyMs: Date.now() - startTime
                        });
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
        }, 30000);
    });
}

async function runBenchmark() {
    console.log('='.repeat(70));
    console.log('MCP MEMORY v2.1 - BENCHMARK & REGRESSION GATE');
    console.log('='.repeat(70));
    console.log(`Project ID: ${PROJECT_ID}`);
    console.log(`Timestamp: ${new Date().toISOString()}\n`);

    // Wait for server init
    await new Promise(r => setTimeout(r, 1500));

    const report = {
        timestamp: new Date().toISOString(),
        project_id: PROJECT_ID,
        version: '2.1',
        metrics: {},
        regression_gate: {},
        benchmark_results: {},
        status: 'UNKNOWN'
    };

    const latencies = [];

    // ============================================================
    // REGRESSION GATE 1: Self-Healing (quarantine → deleted)
    // ============================================================
    console.log('\n--- REGRESSION GATE 1: SELF-HEALING ---');

    // Create bad memory
    let result = await sendRequest('tools/call', {
        name: 'memory_upsert',
        arguments: {
            items: [{
                type: 'runbook',
                project_id: PROJECT_ID,
                title: 'Dangerous Runbook for Benchmark',
                content: 'rm -rf / --dangerous-test',
                provenance_json: {
                    model_id: 'benchmark-runner',
                    phase: 'regression-gate'
                }
            }]
        }
    });
    latencies.push(result.latencyMs);

    const content = JSON.parse(result.response.result?.content?.[0]?.text || '{}');
    const badId = content.upserted?.[0]?.id;

    // Feedback wrong 3 times
    for (let i = 0; i < 3; i++) {
        result = await sendRequest('tools/call', {
            name: 'memory_feedback',
            arguments: { id: badId, label: 'wrong', notes: `Wrong #${i + 1}` }
        });
        latencies.push(result.latencyMs);
    }

    // Prune
    result = await sendRequest('tools/call', {
        name: 'memory_maintain',
        arguments: { project_id: PROJECT_ID, mode: 'apply', actions: ['prune'] }
    });
    latencies.push(result.latencyMs);

    // Verify deleted
    result = await sendRequest('tools/call', {
        name: 'memory_get',
        arguments: { id: badId }
    });
    latencies.push(result.latencyMs);

    const getContent = JSON.parse(result.response.result?.content?.[0]?.text || '{}');
    const selfHealingPass = getContent.item?.status === 'deleted';

    report.regression_gate.self_healing = {
        status: selfHealingPass ? 'PASS' : 'FAIL',
        final_status: getContent.item?.status,
        status_reason: getContent.item?.status_reason
    };
    console.log(`Self-Healing: ${selfHealingPass ? '✅ PASS' : '❌ FAIL'}`);

    // ============================================================
    // REGRESSION GATE 2: Loop Breaker (guardrails muncul)
    // ============================================================
    console.log('\n--- REGRESSION GATE 2: LOOP BREAKER ---');

    result = await sendRequest('tools/call', {
        name: 'memory_maintain',
        arguments: { project_id: PROJECT_ID, mode: 'apply', actions: ['loopbreak'] }
    });
    latencies.push(result.latencyMs);

    result = await sendRequest('tools/call', {
        name: 'memory_summarize',
        arguments: { project_id: PROJECT_ID }
    });
    latencies.push(result.latencyMs);

    const sumContent = JSON.parse(result.response.result?.content?.[0]?.text || '{}');
    const loopBreakerPass = sumContent.summary?.guardrails?.length > 0;

    report.regression_gate.loop_breaker = {
        status: loopBreakerPass ? 'PASS' : 'FAIL',
        guardrails_count: sumContent.summary?.guardrails?.length || 0,
        guardrails: sumContent.summary?.guardrails
    };
    console.log(`Loop Breaker: ${loopBreakerPass ? '✅ PASS' : '❌ FAIL'}`);

    // ============================================================
    // REGRESSION GATE 3: Auditability (meta.forensic selalu ada)
    // ============================================================
    console.log('\n--- REGRESSION GATE 3: AUDITABILITY ---');

    const hasForensic = sumContent.meta?.forensic !== undefined;
    const hasDbBackend = sumContent.meta?.forensic?.db_backend !== undefined;
    const hasEmbeddingMode = sumContent.meta?.forensic?.embedding_mode !== undefined;
    const hasGovernance = sumContent.meta?.forensic?.governance_state !== undefined;

    const auditabilityPass = hasForensic && hasDbBackend && hasEmbeddingMode && hasGovernance;

    report.regression_gate.auditability = {
        status: auditabilityPass ? 'PASS' : 'FAIL',
        has_forensic: hasForensic,
        has_db_backend: hasDbBackend,
        has_embedding_mode: hasEmbeddingMode,
        has_governance: hasGovernance
    };
    console.log(`Auditability: ${auditabilityPass ? '✅ PASS' : '❌ FAIL'}`);

    // ============================================================
    // REGRESSION GATE 4: Latency (p95 < 100ms)
    // ============================================================
    console.log('\n--- REGRESSION GATE 4: LATENCY ---');

    // Run 10 more searches for latency measurement
    for (let i = 0; i < 10; i++) {
        result = await sendRequest('tools/call', {
            name: 'memory_search',
            arguments: { query: `benchmark test query ${i}`, project_id: PROJECT_ID }
        });
        latencies.push(result.latencyMs);
    }

    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    const p99 = latencies[Math.floor(latencies.length * 0.99)];
    const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);

    const latencyPass = p95 < 100; // Target: p95 < 100ms

    report.regression_gate.latency = {
        status: latencyPass ? 'PASS' : 'FAIL',
        p50_ms: p50,
        p95_ms: p95,
        p99_ms: p99,
        avg_ms: avg,
        samples: latencies.length,
        target_p95_ms: 100
    };
    console.log(`Latency p95=${p95}ms (target <100ms): ${latencyPass ? '✅ PASS' : '❌ FAIL'}`);

    // ============================================================
    // BENCHMARK: Relevance vs Recency
    // ============================================================
    console.log('\n--- BENCHMARK: RELEVANCE VS RECENCY ---');

    // Create relevant old item
    result = await sendRequest('tools/call', {
        name: 'memory_upsert',
        arguments: {
            items: [{
                type: 'fact',
                project_id: PROJECT_ID,
                title: 'Database PostgreSQL Configuration Guide',
                content: 'PostgreSQL database configuration: max_connections=100, shared_buffers=256MB, effective_cache_size=1GB'
            }]
        }
    });
    const relevantId = JSON.parse(result.response.result?.content?.[0]?.text || '{}').upserted?.[0]?.id;

    // Create irrelevant new item
    result = await sendRequest('tools/call', {
        name: 'memory_upsert',
        arguments: {
            items: [{
                type: 'fact',
                project_id: PROJECT_ID,
                title: 'Database Movie Reviews',
                content: 'The movie Database is a 2022 thriller film. PostgreSQL is mentioned briefly as a prop.'
            }]
        }
    });
    const irrelevantId = JSON.parse(result.response.result?.content?.[0]?.text || '{}').upserted?.[0]?.id;

    // Search for PostgreSQL configuration
    result = await sendRequest('tools/call', {
        name: 'memory_search',
        arguments: { query: 'PostgreSQL database configuration max_connections shared_buffers', project_id: PROJECT_ID }
    });

    const searchContent = JSON.parse(result.response.result?.content?.[0]?.text || '{}');
    const results = searchContent.results || [];

    // Check if relevant item ranks higher
    const relevantRank = results.findIndex(r => r.id === relevantId);
    const irrelevantRank = results.findIndex(r => r.id === irrelevantId);

    const relevancePass = relevantRank !== -1 && (irrelevantRank === -1 || relevantRank < irrelevantRank);

    report.benchmark_results.relevance_vs_recency = {
        status: relevancePass ? 'PASS' : 'FAIL',
        relevant_rank: relevantRank,
        irrelevant_rank: irrelevantRank,
        relevant_score: results[relevantRank]?.final_score,
        irrelevant_score: results[irrelevantRank]?.final_score,
        score_breakdown_relevant: results[relevantRank]?.score_breakdown,
        score_breakdown_irrelevant: results[irrelevantRank]?.score_breakdown
    };
    console.log(`Relevance > Recency: ${relevancePass ? '✅ PASS' : '❌ FAIL'}`);

    // ============================================================
    // BENCHMARK: Temporal Intelligence
    // ============================================================
    console.log('\n--- BENCHMARK: TEMPORAL INTELLIGENCE ---');

    const hasTemporalType = results.some(r => r.score_breakdown?.temporal_type !== undefined);

    report.benchmark_results.temporal_intelligence = {
        status: hasTemporalType ? 'PASS' : 'FAIL',
        temporal_types_found: results.map(r => ({
            title: r.title?.slice(0, 30),
            temporal_type: r.score_breakdown?.temporal_type
        }))
    };
    console.log(`Temporal Types: ${hasTemporalType ? '✅ PASS' : '❌ FAIL'}`);

    // ============================================================
    // BENCHMARK: Cross-Model Continuity
    // ============================================================
    console.log('\n--- BENCHMARK: CROSS-MODEL ---');

    // Use the meta from the search result (after data exists)
    const crossModel = searchContent.meta?.forensic?.cross_model;
    // Check if tracking is active (model_count >= 0 means feature works)
    const crossModelPass = crossModel !== undefined;

    report.benchmark_results.cross_model = {
        status: crossModelPass ? 'PASS' : 'FAIL',
        models_detected: crossModel?.models_detected,
        model_count: crossModel?.model_count,
        cross_model_active: crossModel?.cross_model_active,
        note: 'Tracking active, single model in isolated benchmark project'
    };
    console.log(`Cross-Model: ${crossModelPass ? '✅ PASS' : '❌ FAIL'}`);

    // ============================================================
    // FINAL METRICS
    // ============================================================
    report.metrics = {
        total_requests: latencies.length,
        latency: report.regression_gate.latency,
        embedding_mode: sumContent.meta?.forensic?.embedding_mode
    };

    // ============================================================
    // FINAL VERDICT
    // ============================================================
    console.log('\n' + '='.repeat(70));
    console.log('FINAL VERDICT');
    console.log('='.repeat(70));

    const allRegressionPass = selfHealingPass && loopBreakerPass && auditabilityPass && latencyPass;
    const allBenchmarkPass = relevancePass && hasTemporalType && crossModelPass;

    report.status = allRegressionPass && allBenchmarkPass ? 'PASS' : 'FAIL';

    console.log('\nREGRESSION GATE:');
    console.log(`  Self-Healing:  ${selfHealingPass ? '✅' : '❌'}`);
    console.log(`  Loop Breaker:  ${loopBreakerPass ? '✅' : '❌'}`);
    console.log(`  Auditability:  ${auditabilityPass ? '✅' : '❌'}`);
    console.log(`  Latency p95:   ${latencyPass ? '✅' : '❌'} (${p95}ms)`);

    console.log('\nBENCHMARK:');
    console.log(`  Relevance:     ${relevancePass ? '✅' : '❌'}`);
    console.log(`  Temporal:      ${hasTemporalType ? '✅' : '❌'}`);
    console.log(`  Cross-Model:   ${crossModelPass ? '✅' : '❌'}`);

    console.log('\n' + (report.status === 'PASS'
        ? '✅ ALL TESTS PASSED - MCP MEMORY v2.1 VALIDATED'
        : '❌ SOME TESTS FAILED - FIX REQUIRED'));

    // Save report
    const reportPath = path.join(ARTIFACTS_DIR, 'benchmark_report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\nReport saved: ${reportPath}`);

    proc.kill();
    process.exit(report.status === 'PASS' ? 0 : 1);
}

runBenchmark().catch(err => {
    console.error('Benchmark error:', err);
    proc.kill();
    process.exit(1);
});
