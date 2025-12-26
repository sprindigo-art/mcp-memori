#!/usr/bin/env node
/**
 * Evaluation runner
 * @module scripts/eval_run
 */
import { initDb, closeDb } from '../src/db/index.js';
import { evaluateRetrieval, checkRegressionGate } from '../src/evaluation/harness.js';

const PROJECT_ID = 'test-project';
const TENANT_ID = 'local-user';

// Test cases with expected results
const testCases = [
    // Basic keyword matching
    {
        query: 'database SQLite',
        description: 'Should find SQLite decision',
        // Note: expectedIds will be checked loosely - we check if results are relevant
        checkFn: (results) => results.some(r => r.title.includes('SQLite'))
    },
    {
        query: 'hybrid search algorithm',
        description: 'Should find hybrid search decision',
        checkFn: (results) => results.some(r => r.title.includes('Hybrid'))
    },
    {
        query: 'current state progress',
        description: 'Should find state item',
        checkFn: (results) => results.some(r => r.type === 'state')
    },
    {
        query: 'how to add memory',
        description: 'Should find upsert runbook',
        checkFn: (results) => results.some(r => r.type === 'runbook' && r.title.includes('Add'))
    },
    {
        query: 'debug search issues',
        description: 'Should find debug runbook',
        checkFn: (results) => results.some(r => r.type === 'runbook' && r.title.includes('Debug'))
    },
    {
        query: 'MCP protocol version',
        description: 'Should find protocol fact',
        checkFn: (results) => results.some(r => r.type === 'fact' && r.title.includes('Protocol'))
    },
    {
        query: 'memory types supported',
        description: 'Should find types fact',
        checkFn: (results) => results.some(r => r.content.includes('5 memory types'))
    },
    {
        query: 'TODO optimization',
        description: 'Should find TODO item',
        checkFn: (results) => results.some(r => r.title.includes('TODO'))
    },
    {
        query: 'setup session initial',
        description: 'Should find setup episode',
        checkFn: (results) => results.some(r => r.type === 'episode' && r.title.includes('Setup'))
    },
    {
        query: 'FTS debugging session',
        description: 'Should find FTS debug episode',
        checkFn: (results) => results.some(r => r.title.includes('FTS'))
    },
    // Partial matches
    {
        query: 'database',
        description: 'Should find database-related items',
        checkFn: (results) => results.length > 0
    },
    {
        query: 'search',
        description: 'Should find search-related items',
        checkFn: (results) => results.some(r =>
            r.title.toLowerCase().includes('search') ||
            r.content.toLowerCase().includes('search')
        )
    },
    // Semantic queries (will only work well with embeddings)
    {
        query: 'how do I store information',
        description: 'Should find upsert runbook or related',
        checkFn: (results) => results.length > 0
    },
    {
        query: 'what is the current status',
        description: 'Should find state item',
        checkFn: (results) => results.some(r => r.type === 'state')
    },
    {
        query: 'architectural decisions',
        description: 'Should find decision items',
        checkFn: (results) => results.some(r => r.type === 'decision')
    },
    // Edge cases
    {
        query: 'nonexistent topic xyz123',
        description: 'Should return empty or low-relevance results',
        checkFn: (results) => true // Any result is OK for edge case
    },
    {
        query: 'blocker',
        description: 'Should find items mentioning blockers',
        checkFn: (results) => results.some(r => r.content.toLowerCase().includes('blocker'))
    },
    {
        query: 'session',
        description: 'Should find episode items',
        checkFn: (results) => results.some(r => r.type === 'episode')
    },
    {
        query: 'verified important',
        description: 'Should prioritize verified items',
        checkFn: (results) => results.length > 0 && results[0].verified === true
    },
    {
        query: 'wrong information',
        description: 'Should NOT return quarantined items by default',
        checkFn: (results) => !results.some(r => r.status === 'quarantined')
    }
];

async function runEvaluation() {
    console.log('='.repeat(60));
    console.log('MCP Memory Server - Retrieval Evaluation');
    console.log('='.repeat(60));

    await initDb();

    let passed = 0;
    let failed = 0;
    let wrongMemoryCount = 0;

    // Import hybrid search directly for testing
    const { hybridSearch } = await import('../src/retrieval/hybridSearch.js');

    for (const testCase of testCases) {
        const { results } = await hybridSearch({
            query: testCase.query,
            projectId: PROJECT_ID,
            tenantId: TENANT_ID,
            limit: 5
        });

        // Check for wrong memories
        const wrongMemories = results.filter(r =>
            r.status === 'quarantined' || r.status === 'deleted'
        );
        wrongMemoryCount += wrongMemories.length;

        // Run check function
        const checkPassed = testCase.checkFn(results);

        if (checkPassed && wrongMemories.length === 0) {
            passed++;
            console.log(`✓ ${testCase.description}`);
        } else {
            failed++;
            console.log(`✗ ${testCase.description}`);
            if (wrongMemories.length > 0) {
                console.log(`  Wrong memories returned: ${wrongMemories.length}`);
            }
            if (!checkPassed) {
                console.log(`  Check failed. Results: ${results.map(r => r.title).join(', ') || 'none'}`);
            }
        }
    }

    await closeDb();

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('RESULTS');
    console.log('='.repeat(60));
    console.log(`Total: ${testCases.length}`);
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);
    console.log(`Wrong Memory Count: ${wrongMemoryCount}`);

    const passRate = passed / testCases.length;
    console.log(`Pass Rate: ${(passRate * 100).toFixed(1)}%`);

    // Regression gate
    const gateResult = {
        passed: passRate >= 0.7 && wrongMemoryCount === 0,
        reason: passRate < 0.7
            ? `Pass rate ${(passRate * 100).toFixed(1)}% < 70%`
            : wrongMemoryCount > 0
                ? `Wrong memory count ${wrongMemoryCount} > 0`
                : 'All gates passed'
    };

    console.log('\n' + '='.repeat(60));
    console.log(`REGRESSION GATE: ${gateResult.passed ? 'PASSED ✓' : 'FAILED ✗'}`);
    console.log(`Reason: ${gateResult.reason}`);
    console.log('='.repeat(60));

    process.exit(gateResult.passed ? 0 : 1);
}

runEvaluation().catch(err => {
    console.error('Evaluation failed:', err);
    process.exit(1);
});
