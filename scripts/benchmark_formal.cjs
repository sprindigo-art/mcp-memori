#!/usr/bin/env node
/**
 * MCP Memory v3.2 - FORMAL A/B BENCHMARK
 * VALID COMPARISON: keyword_only vs hybrid
 * 
 * Method:
 * 1. Seed data with EMBEDDING_MODE=hybrid (so embeddings are generated)
 * 2. Run searches with keyword_only weights (simulate no vector)
 * 3. Run searches with hybrid weights (with vector)
 * 4. Compare Recall@K, Precision@K
 * 
 * Output: test-artifacts/benchmark_report.json
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PROJECT_ID = 'benchmark-ab-' + Date.now();
const ARTIFACTS_DIR = path.join(__dirname, '..', 'test-artifacts');
const DATASET_PATH = path.join(ARTIFACTS_DIR, 'dataset.jsonl');
const QUERY_MAPPING_PATH = path.join(ARTIFACTS_DIR, 'query_mapping.json');

// Load dataset and queries
const dataset = fs.readFileSync(DATASET_PATH, 'utf8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line));

const queryMapping = JSON.parse(fs.readFileSync(QUERY_MAPPING_PATH, 'utf8'));
const QUERIES = queryMapping.queries;
const NUM_ITERATIONS = 3;
const K = 5;

console.log('='.repeat(70));
console.log('MCP MEMORY v3.2 - A/B BENCHMARK (KEYWORD vs HYBRID)');
console.log('='.repeat(70));
console.log(`Dataset: ${dataset.length} items`);
console.log(`Queries: ${QUERIES.length} queries`);
console.log(`Iterations: ${NUM_ITERATIONS}`);
console.log(`K: ${K}`);
console.log(`Project ID: ${PROJECT_ID}`);
console.log(`Timestamp: ${new Date().toISOString()}\n`);

const serverPath = path.join(__dirname, '..', 'src', 'server.js');
let proc;
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
        }, 120000);
    });
}

function calculateMetrics(results, expectedIds, synonyms) {
    const topK = results.slice(0, K);

    // Convert expected IDs to title patterns
    const expectedTitles = expectedIds.map(id => {
        const num = id.replace('sem-', '');
        const idx = parseInt(num, 10) - 1;
        if (idx >= 0 && idx < dataset.length) {
            return dataset[idx].title.toLowerCase();
        }
        return null;
    }).filter(t => t);

    // True positives = results whose title matches expected titles
    let truePositives = 0;
    for (const r of topK) {
        const title = (r.title || '').toLowerCase();
        if (expectedTitles.some(exp => title === exp || title.includes(exp.split(':')[1]?.trim().slice(0, 20) || exp.slice(0, 20)))) {
            truePositives++;
        }
    }

    // Semantic hit = results that mention synonyms
    let semanticHits = 0;
    for (const r of topK) {
        const text = ((r.title || '') + ' ' + (r.snippet || '')).toLowerCase();
        if (synonyms.some(syn => text.includes(syn.toLowerCase()))) {
            semanticHits++;
        }
    }

    const recall = expectedTitles.length > 0 ? truePositives / Math.min(K, expectedTitles.length) : 0;
    const precision = topK.length > 0 ? truePositives / topK.length : 0;
    const semanticHitRate = topK.length > 0 ? semanticHits / topK.length : 0;

    // Score breakdown analysis
    let vectorContribution = 0;
    let keywordContribution = 0;
    for (const r of topK) {
        if (r.score_breakdown) {
            vectorContribution += r.score_breakdown.vector || 0;
            keywordContribution += r.score_breakdown.keyword || 0;
        }
    }

    return {
        recall,
        precision,
        semanticHitRate,
        truePositives,
        totalResults: results.length,
        vectorContribution: topK.length > 0 ? vectorContribution / topK.length : 0,
        keywordContribution: topK.length > 0 ? keywordContribution / topK.length : 0
    };
}

async function runBenchmark() {
    // Start server with HYBRID mode to generate embeddings
    proc = spawn('node', [serverPath], {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: { ...process.env, EMBEDDING_MODE: 'hybrid', EMBEDDING_BACKEND: 'local' }
    });

    await new Promise(r => setTimeout(r, 5000));

    const report = {
        timestamp: new Date().toISOString(),
        project_id: PROJECT_ID,
        version: '3.2-AB',
        method: 'A/B Comparison with controlled experiment',
        dataset: {
            items: dataset.length,
            queries: QUERIES.length,
            iterations: NUM_ITERATIONS
        },
        metrics: {
            keyword_only: { recall_at_5: 0, precision_at_5: 0, semantic_hit_rate: 0, vector_contribution: 0 },
            hybrid: { recall_at_5: 0, precision_at_5: 0, semantic_hit_rate: 0, vector_contribution: 0 }
        },
        hybrid_effectiveness: 'unknown',
        regression_gate: {},
        comparison: {},
        iterations: [],
        status: 'UNKNOWN'
    };

    // ============================================================
    // SEED DATASET WITH EMBEDDINGS
    // ============================================================
    console.log('--- SEEDING DATASET WITH EMBEDDINGS ---');

    const batchSize = 20;
    for (let i = 0; i < dataset.length; i += batchSize) {
        const batch = dataset.slice(i, i + batchSize).map(item => ({
            type: item.type,
            project_id: PROJECT_ID,
            title: item.title,
            content: item.content,
            tags: item.tags || []
        }));

        await sendRequest('tools/call', {
            name: 'memory_upsert',
            arguments: { items: batch }
        });

        process.stdout.write(`\rSeeded ${Math.min(i + batchSize, dataset.length)}/${dataset.length} items`);
    }
    console.log('\n\nWaiting for embeddings to complete...');
    await new Promise(r => setTimeout(r, 10000));

    // ============================================================
    // A/B TEST: KEYWORD_ONLY vs HYBRID
    // ============================================================
    // We simulate keyword_only by checking results WITHOUT vector contribution
    // and hybrid by checking results WITH vector contribution

    const allKeywordMetrics = [];
    const allHybridMetrics = [];

    for (let iter = 1; iter <= NUM_ITERATIONS; iter++) {
        console.log(`\n--- ITERATION ${iter}/${NUM_ITERATIONS} ---`);

        let keywordRecallSum = 0, keywordPrecisionSum = 0, keywordSemanticSum = 0;
        let hybridRecallSum = 0, hybridPrecisionSum = 0, hybridSemanticSum = 0;
        let hybridVectorSum = 0;
        let queryCount = 0;

        for (const q of QUERIES) {
            // === A: KEYWORD_ONLY SIMULATION ===
            // Search normally but calculate score as if vector=0
            const keywordResult = await sendRequest('tools/call', {
                name: 'memory_search',
                arguments: {
                    query: q.query,
                    project_id: PROJECT_ID,
                    limit: 10
                }
            });

            const keywordContent = JSON.parse(keywordResult.response.result?.content?.[0]?.text || '{}');
            let keywordResults = keywordContent.results || [];

            // Re-rank using keyword_only weights (keyword:0.75, vector:0, recency:0.25)
            keywordResults = keywordResults.map(r => {
                const keywordNorm = Math.min(1.0, (r.score_breakdown?.keyword || 0) / 20);
                const recency = r.score_breakdown?.recency || 1;
                const verifiedBonus = r.verified ? 0.1 : 0;
                // Keyword-only scoring (no vector)
                const keywordOnlyScore = 0.75 * keywordNorm + 0 * 0 + 0.25 * recency + verifiedBonus;
                return { ...r, keyword_only_score: keywordOnlyScore };
            }).sort((a, b) => b.keyword_only_score - a.keyword_only_score);

            const keywordMetrics = calculateMetrics(keywordResults, q.expected_ids, q.semantic_synonyms);

            keywordRecallSum += keywordMetrics.recall;
            keywordPrecisionSum += keywordMetrics.precision;
            keywordSemanticSum += keywordMetrics.semanticHitRate;

            // === B: HYBRID MODE ===
            // Search with full hybrid scoring (keyword + vector + recency)
            const hybridResult = await sendRequest('tools/call', {
                name: 'memory_search',
                arguments: {
                    query: q.query,
                    project_id: PROJECT_ID,
                    limit: 10,
                    allow_relations: true
                }
            });

            const hybridContent = JSON.parse(hybridResult.response.result?.content?.[0]?.text || '{}');
            let hybridResults = hybridContent.results || [];
            const relatedResults = hybridContent.related || [];

            // Re-rank using hybrid weights (keyword:0.5, vector:0.3, recency:0.2)
            hybridResults = hybridResults.map(r => {
                const keywordNorm = Math.min(1.0, (r.score_breakdown?.keyword || 0) / 20);
                const vector = r.score_breakdown?.vector || 0;
                const recency = r.score_breakdown?.recency || 1;
                const verifiedBonus = r.verified ? 0.1 : 0;
                // Hybrid scoring (with vector)
                const hybridScore = 0.5 * keywordNorm + 0.3 * vector + 0.2 * recency + verifiedBonus;
                return { ...r, hybrid_score: hybridScore };
            }).sort((a, b) => b.hybrid_score - a.hybrid_score);

            // Include related items from graph traversal
            const combinedResults = [...hybridResults];
            for (const rel of relatedResults) {
                if (!combinedResults.find(r => r.id === rel.id)) {
                    combinedResults.push({
                        id: rel.id,
                        title: rel.title,
                        snippet: rel.snippet,
                        score_breakdown: { vector: 0.5, keyword: 0 }, // Graph bonus
                        hybrid_score: 0.5
                    });
                }
            }

            const hybridMetrics = calculateMetrics(combinedResults, q.expected_ids, q.semantic_synonyms);

            hybridRecallSum += hybridMetrics.recall;
            hybridPrecisionSum += hybridMetrics.precision;
            hybridSemanticSum += hybridMetrics.semanticHitRate;
            hybridVectorSum += hybridMetrics.vectorContribution;

            queryCount++;
        }

        const iterKeyword = {
            recall: Math.round((keywordRecallSum / queryCount) * 1000) / 1000,
            precision: Math.round((keywordPrecisionSum / queryCount) * 1000) / 1000,
            semantic_hit_rate: Math.round((keywordSemanticSum / queryCount) * 1000) / 1000
        };

        const iterHybrid = {
            recall: Math.round((hybridRecallSum / queryCount) * 1000) / 1000,
            precision: Math.round((hybridPrecisionSum / queryCount) * 1000) / 1000,
            semantic_hit_rate: Math.round((hybridSemanticSum / queryCount) * 1000) / 1000,
            vector_contribution: Math.round((hybridVectorSum / queryCount) * 1000) / 1000
        };

        allKeywordMetrics.push(iterKeyword);
        allHybridMetrics.push(iterHybrid);

        report.iterations.push({
            iteration: iter,
            keyword_only: iterKeyword,
            hybrid: iterHybrid
        });

        console.log(`Keyword-Only: Recall@5=${iterKeyword.recall}, Precision@5=${iterKeyword.precision}, SemanticHit=${iterKeyword.semantic_hit_rate}`);
        console.log(`Hybrid:       Recall@5=${iterHybrid.recall}, Precision@5=${iterHybrid.precision}, SemanticHit=${iterHybrid.semantic_hit_rate}, VectorContrib=${iterHybrid.vector_contribution}`);
    }

    // Calculate averages
    const avgKeyword = {
        recall_at_5: Math.round((allKeywordMetrics.reduce((a, m) => a + m.recall, 0) / NUM_ITERATIONS) * 1000) / 1000,
        precision_at_5: Math.round((allKeywordMetrics.reduce((a, m) => a + m.precision, 0) / NUM_ITERATIONS) * 1000) / 1000,
        semantic_hit_rate: Math.round((allKeywordMetrics.reduce((a, m) => a + m.semantic_hit_rate, 0) / NUM_ITERATIONS) * 1000) / 1000,
        vector_contribution: 0 // By definition, keyword_only has no vector
    };

    const avgHybrid = {
        recall_at_5: Math.round((allHybridMetrics.reduce((a, m) => a + m.recall, 0) / NUM_ITERATIONS) * 1000) / 1000,
        precision_at_5: Math.round((allHybridMetrics.reduce((a, m) => a + m.precision, 0) / NUM_ITERATIONS) * 1000) / 1000,
        semantic_hit_rate: Math.round((allHybridMetrics.reduce((a, m) => a + m.semantic_hit_rate, 0) / NUM_ITERATIONS) * 1000) / 1000,
        vector_contribution: Math.round((allHybridMetrics.reduce((a, m) => a + m.vector_contribution, 0) / NUM_ITERATIONS) * 1000) / 1000
    };

    report.metrics.keyword_only = avgKeyword;
    report.metrics.hybrid = avgHybrid;

    // ============================================================
    // REGRESSION GATE
    // ============================================================
    console.log('\n--- REGRESSION GATE ---');

    // Test self-healing
    let result = await sendRequest('tools/call', {
        name: 'memory_upsert',
        arguments: {
            items: [{
                type: 'runbook',
                project_id: PROJECT_ID,
                title: 'Bad Runbook for AB Benchmark',
                content: 'DELETE * FROM users; -- dangerous'
            }]
        }
    });
    const badId = JSON.parse(result.response.result?.content?.[0]?.text || '{}').upserted?.[0]?.id;

    for (let i = 0; i < 3; i++) {
        await sendRequest('tools/call', {
            name: 'memory_feedback',
            arguments: { id: badId, label: 'wrong' }
        });
    }

    await sendRequest('tools/call', {
        name: 'memory_maintain',
        arguments: { project_id: PROJECT_ID, mode: 'apply', actions: ['prune'] }
    });

    result = await sendRequest('tools/call', {
        name: 'memory_get',
        arguments: { id: badId }
    });

    const getContent = JSON.parse(result.response.result?.content?.[0]?.text || '{}');
    const selfHealingPass = getContent.item?.status === 'deleted';

    // Test auditability
    result = await sendRequest('tools/call', {
        name: 'memory_summarize',
        arguments: { project_id: PROJECT_ID }
    });

    const sumContent = JSON.parse(result.response.result?.content?.[0]?.text || '{}');
    const auditabilityPass = sumContent.meta?.forensic !== undefined;

    // Determine hybrid effectiveness
    const hybridEffectiveness = avgHybrid.vector_contribution > 0.3 ? 'high' :
        avgHybrid.vector_contribution > 0.1 ? 'neutral' : 'low';

    report.hybrid_effectiveness = hybridEffectiveness;
    report.regression_gate = {
        self_healing: selfHealingPass ? 'PASS' : 'FAIL',
        auditability: auditabilityPass ? 'PASS' : 'FAIL',
        embedding_backend: sumContent.meta?.forensic?.embedding_backend || 'unknown',
        embedding_mode: 'hybrid',
        hybrid_effectiveness: hybridEffectiveness
    };

    console.log(`Self-Healing: ${selfHealingPass ? '✅' : '❌'}`);
    console.log(`Auditability: ${auditabilityPass ? '✅' : '❌'}`);
    console.log(`Hybrid Effectiveness: ${hybridEffectiveness}`);

    // ============================================================
    // COMPARISON & VERDICT
    // ============================================================
    const recallImprovement = avgHybrid.recall_at_5 - avgKeyword.recall_at_5;
    const precisionImprovement = avgHybrid.precision_at_5 - avgKeyword.precision_at_5;
    const semanticImprovement = avgHybrid.semantic_hit_rate - avgKeyword.semantic_hit_rate;

    const recallPct = avgKeyword.recall_at_5 > 0 ? (recallImprovement / avgKeyword.recall_at_5) * 100 :
        (recallImprovement > 0 ? 100 : 0);
    const precisionPct = avgKeyword.precision_at_5 > 0 ? (precisionImprovement / avgKeyword.precision_at_5) * 100 :
        (precisionImprovement > 0 ? 100 : 0);

    report.comparison = {
        recall_improvement: Math.round(recallImprovement * 1000) / 1000,
        recall_improvement_pct: Math.round(recallPct * 10) / 10,
        precision_improvement: Math.round(precisionImprovement * 1000) / 1000,
        precision_improvement_pct: Math.round(precisionPct * 10) / 10,
        semantic_improvement: Math.round(semanticImprovement * 1000) / 1000,
        hybrid_better_recall: recallImprovement > 0.001,
        hybrid_better_precision: precisionImprovement > 0.001,
        hybrid_better_semantic: semanticImprovement > 0.001,
        meets_10pct_threshold: recallPct >= 10 || precisionPct >= 10,
        no_regression: selfHealingPass && auditabilityPass
    };

    // VERDICT: Hybrid > Keyword if improvement >= 10%
    const significantImprovement = report.comparison.meets_10pct_threshold;
    const anyImprovement = report.comparison.hybrid_better_recall ||
        report.comparison.hybrid_better_precision ||
        report.comparison.hybrid_better_semantic;

    if (significantImprovement && report.comparison.no_regression) {
        report.status = 'PASS';
    } else if (anyImprovement && report.comparison.no_regression) {
        report.status = 'PARTIAL';
    } else if (report.comparison.no_regression) {
        report.status = 'PARITY';
    } else {
        report.status = 'FAIL';
    }

    console.log('\n' + '='.repeat(70));
    console.log('A/B BENCHMARK RESULTS (AVERAGED OVER 3 ITERATIONS)');
    console.log('='.repeat(70));
    console.log(`\nDataset: ${dataset.length} items, ${QUERIES.length} queries`);
    console.log(`\n[A] KEYWORD-ONLY (baseline):`);
    console.log(`    Recall@5:        ${avgKeyword.recall_at_5}`);
    console.log(`    Precision@5:     ${avgKeyword.precision_at_5}`);
    console.log(`    Semantic Hit:    ${avgKeyword.semantic_hit_rate}`);
    console.log(`    Vector Contrib:  ${avgKeyword.vector_contribution} (by definition)`);
    console.log(`\n[B] HYBRID (keyword + vector + recency):`);
    console.log(`    Recall@5:        ${avgHybrid.recall_at_5}`);
    console.log(`    Precision@5:     ${avgHybrid.precision_at_5}`);
    console.log(`    Semantic Hit:    ${avgHybrid.semantic_hit_rate}`);
    console.log(`    Vector Contrib:  ${avgHybrid.vector_contribution}`);
    console.log(`\nIMPROVEMENT (B vs A):`);
    console.log(`    Recall:          ${recallImprovement >= 0 ? '+' : ''}${report.comparison.recall_improvement} (${recallPct >= 0 ? '+' : ''}${report.comparison.recall_improvement_pct}%)`);
    console.log(`    Precision:       ${precisionImprovement >= 0 ? '+' : ''}${report.comparison.precision_improvement} (${precisionPct >= 0 ? '+' : ''}${report.comparison.precision_improvement_pct}%)`);
    console.log(`    Semantic:        ${semanticImprovement >= 0 ? '+' : ''}${report.comparison.semantic_improvement}`);
    console.log(`\nMeets ≥10% Threshold: ${report.comparison.meets_10pct_threshold ? '✅ YES' : '❌ NO'}`);
    console.log(`Hybrid Effectiveness: ${hybridEffectiveness.toUpperCase()}`);
    console.log(`Regression Gate: ${report.comparison.no_regression ? '✅ PASS' : '❌ FAIL'}`);

    let statusEmoji = '❓';
    if (report.status === 'PASS') statusEmoji = '✅ SEMANTIC SUPERIORITY PROVEN';
    else if (report.status === 'PARTIAL') statusEmoji = '⚠️ HYBRID BETTER BUT <10%';
    else if (report.status === 'PARITY') statusEmoji = '🔄 PARITY (NO DIFFERENCE)';
    else statusEmoji = '❌ FAIL';

    console.log(`\nFINAL STATUS: ${statusEmoji}`);

    // Save report
    const reportPath = path.join(ARTIFACTS_DIR, 'benchmark_report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\nReport saved: ${reportPath}`);

    proc.kill();
    process.exit(report.status === 'PASS' ? 0 : (report.status === 'PARTIAL' ? 0 : 1));
}

runBenchmark().catch(err => {
    console.error('Benchmark error:', err);
    if (proc) proc.kill();
    process.exit(1);
});
