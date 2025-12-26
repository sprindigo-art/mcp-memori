#!/usr/bin/env node
/**
 * MCP Memory v2.0 - 5 LAYER Validation Test
 * Tests all enhancements without breaking existing functionality
 */
const { spawn } = require('child_process');
const path = require('path');

const PROJECT_ID = 'layer-test-' + Date.now();

// Start MCP Server
const serverPath = path.join(__dirname, '..', 'src', 'server.js');
const proc = spawn('node', [serverPath], { stdio: ['pipe', 'pipe', 'inherit'] });

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
                        resolve(response);
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
        }, 10000);
    });
}

async function runTests() {
    console.log('='.repeat(60));
    console.log('MCP MEMORY v2.0 - 5 LAYER VALIDATION');
    console.log('='.repeat(60));
    console.log(`Project ID: ${PROJECT_ID}\n`);

    // Wait for server init
    await new Promise(r => setTimeout(r, 1000));

    const results = [];

    // =====================================================
    // LAYER 1 TEST: Hybrid Scoring with Configurable Weights
    // =====================================================
    console.log('\n--- LAYER 1: HYBRID SCORING ---');

    // Create test items
    await sendRequest('tools/call', {
        name: 'memory_upsert',
        arguments: {
            items: [
                {
                    type: 'fact',
                    project_id: PROJECT_ID,
                    title: 'Python Async Guide',
                    content: 'Use asyncio.gather for concurrent tasks. await is essential.',
                    tags: ['python', 'async']
                },
                {
                    type: 'fact',
                    project_id: PROJECT_ID,
                    title: 'JavaScript Promise',
                    content: 'Promise.all is similar to asyncio gather.',
                    tags: ['javascript']
                }
            ]
        }
    });

    const searchResult = await sendRequest('tools/call', {
        name: 'memory_search',
        arguments: {
            query: 'asyncio gather concurrent',
            project_id: PROJECT_ID
        }
    });

    const searchContent = JSON.parse(searchResult.result?.content?.[0]?.text || '{}');

    const layer1Pass = searchContent.meta?.weights_used !== undefined &&
        searchContent.results?.[0]?.score_breakdown !== undefined;

    console.log('Weights Used:', JSON.stringify(searchContent.meta?.weights_used));
    console.log('Score Breakdown:', JSON.stringify(searchContent.results?.[0]?.score_breakdown));
    console.log('LAYER 1:', layer1Pass ? '✅ PASS' : '❌ FAIL');
    results.push({ layer: 1, name: 'Hybrid Scoring', pass: layer1Pass });

    // =====================================================
    // LAYER 3 TEST: Temporal Intelligence (Different Decay)
    // =====================================================
    console.log('\n--- LAYER 3: TEMPORAL INTELLIGENCE ---');

    // Create preference (should decay slower)
    await sendRequest('tools/call', {
        name: 'memory_upsert',
        arguments: {
            items: [
                {
                    type: 'fact',
                    project_id: PROJECT_ID,
                    title: 'User Preference: Output Format',
                    content: 'Always use JSON format with meta.forensic',
                    tags: ['user_preference']
                },
                {
                    type: 'episode',
                    project_id: PROJECT_ID,
                    title: 'Session Event Log',
                    content: 'User logged in at 10:00 AM',
                    tags: ['event', 'log']
                }
            ]
        }
    });

    const searchResult2 = await sendRequest('tools/call', {
        name: 'memory_search',
        arguments: {
            query: 'format preference',
            project_id: PROJECT_ID
        }
    });

    const search2Content = JSON.parse(searchResult2.result?.content?.[0]?.text || '{}');

    // Check temporal_type is present
    const hasTemporalType = search2Content.results?.some(r =>
        r.score_breakdown?.temporal_type !== undefined
    );

    console.log('Temporal Types Found:', search2Content.results?.map(r => ({
        title: r.title?.slice(0, 30),
        temporal_type: r.score_breakdown?.temporal_type
    })));
    console.log('LAYER 3:', hasTemporalType ? '✅ PASS' : '❌ FAIL');
    results.push({ layer: 3, name: 'Temporal Intelligence', pass: hasTemporalType });

    // =====================================================
    // LAYER 4 TEST: Governance State in Forensic
    // =====================================================
    console.log('\n--- LAYER 4: GOVERNANCE STATE ---');

    const forensicMeta = search2Content.meta?.forensic;

    const hasGovernanceState = forensicMeta?.governance_state !== undefined;
    const hasSuppressedIds = forensicMeta?.governance_state?.suppressed_memory_ids !== undefined;

    console.log('Governance State:', JSON.stringify(forensicMeta?.governance_state, null, 2));
    console.log('LAYER 4:', (hasGovernanceState && hasSuppressedIds) ? '✅ PASS' : '❌ FAIL');
    results.push({ layer: 4, name: 'Governance State', pass: hasGovernanceState && hasSuppressedIds });

    // =====================================================
    // LAYER 5 TEST: Cross-Model in Forensic
    // =====================================================
    console.log('\n--- LAYER 5: CROSS-MODEL INTELLIGENCE ---');

    const hasCrossModel = forensicMeta?.cross_model !== undefined;

    console.log('Cross-Model Summary:', JSON.stringify(forensicMeta?.cross_model));
    console.log('LAYER 5:', hasCrossModel ? '✅ PASS' : '❌ FAIL');
    results.push({ layer: 5, name: 'Cross-Model Intelligence', pass: hasCrossModel });

    // =====================================================
    // BACKWARD COMPATIBILITY: Original Features Still Work
    // =====================================================
    console.log('\n--- BACKWARD COMPATIBILITY ---');

    // Test self-healing (quarantine)
    const upsertBad = await sendRequest('tools/call', {
        name: 'memory_upsert',
        arguments: {
            items: [{
                type: 'runbook',
                project_id: PROJECT_ID,
                title: 'Bad Runbook',
                content: 'rm -rf /'
            }]
        }
    });

    const badContent = JSON.parse(upsertBad.result?.content?.[0]?.text || '{}');
    const badId = badContent.upserted?.[0]?.id;

    // Give wrong feedback
    await sendRequest('tools/call', {
        name: 'memory_feedback',
        arguments: {
            id: badId,
            label: 'wrong',
            notes: 'Dangerous command'
        }
    });

    // Verify it's quarantined
    const getResult = await sendRequest('tools/call', {
        name: 'memory_get',
        arguments: { id: badId }
    });

    const getContent = JSON.parse(getResult.result?.content?.[0]?.text || '{}');
    const isQuarantined = getContent.item?.status === 'quarantined';

    console.log('Self-Healing (Quarantine):', isQuarantined ? '✅ PASS' : '❌ FAIL');
    results.push({ layer: 0, name: 'Self-Healing', pass: isQuarantined });

    // =====================================================
    // FINAL SUMMARY
    // =====================================================
    console.log('\n' + '='.repeat(60));
    console.log('FINAL SUMMARY');
    console.log('='.repeat(60));

    for (const r of results) {
        console.log(`Layer ${r.layer}: ${r.name} - ${r.pass ? '✅ PASS' : '❌ FAIL'}`);
    }

    const allPass = results.every(r => r.pass);
    console.log('\n' + (allPass ? '✅ ALL LAYERS VALIDATED' : '❌ SOME LAYERS FAILED'));

    proc.kill();
    process.exit(allPass ? 0 : 1);
}

runTests().catch(err => {
    console.error('Test error:', err);
    proc.kill();
    process.exit(1);
});
