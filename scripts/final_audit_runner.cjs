const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const SERVER_PATH = path.join(__dirname, '../src/server.js');
const DB_PATH = path.join(__dirname, '../data/memory.db');
const PROJECT_ID = 'uji-mcp-memori-final-valid-007';

let requestId = 0;
let serverProcess;
let buffer = '';

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function sendRequest(method, params) {
    return new Promise((resolve, reject) => {
        const id = ++requestId;
        const request = JSON.stringify({
            jsonrpc: '2.0',
            id,
            method,
            params
        }) + '\n';

        // Listener for this specific ID
        const checkBuffer = () => {
            const lines = buffer.split('\n');
            buffer = lines.pop(); // Keep partial line

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const response = JSON.parse(line);
                    if (response.id === id) {
                        resolve(response);
                        return true;
                    }
                    // Log notifications or errors
                    if (response.error) {
                        console.error('RPC Error:', JSON.stringify(response.error));
                    }
                } catch (e) {
                    console.error('Parse error:', e.message, line);
                }
            }
            return false;
        };

        const interval = setInterval(() => {
            if (checkBuffer()) clearInterval(interval);
        }, 50);

        serverProcess.stdin.write(request);

        setTimeout(() => {
            clearInterval(interval);
            reject(new Error(`Timeout waiting for response id ${id}`));
        }, 10000);
    });
}

async function runAudit() {
    console.log('STARTING FINAL AUDIT RUNNER...');

    // Kill existing servers
    try { execSync('pkill -f "node.*mcp-memori.*server.js"'); } catch (e) { }

    // Start Server
    serverProcess = spawn('node', [SERVER_PATH], {
        stdio: ['pipe', 'pipe', process.stderr]
    });

    serverProcess.stdout.on('data', (data) => {
        buffer += data.toString();
    });

    // 0. Initialize
    await sendRequest('initialize', {
        protocolVersion: '1.0',
        capabilities: {},
        clientInfo: { name: 'audit-runner' }
    });
    console.log('MCP Server Initialized.');

    // PHASE 2: RELEVANCE VS RECENCY (Re-verify)
    console.log('\n--- PHASE 2: RELEVANCE VS RECENCY ---');

    // We already upserted items in previous session (database persists), 
    // but updated_at might be messy. Let's fix updated_at via sqlite directly again to be sure.
    execSync(`sqlite3 ${DB_PATH} "UPDATE memory_items SET updated_at = datetime('now', '-90 days'), created_at = datetime('now', '-90 days') WHERE id = '4575fbb5-91ca-48cf-bd4b-4b03bc302539';"`);

    const searchRes = await sendRequest('tools/call', {
        name: 'memory_search',
        arguments: {
            project_id: PROJECT_ID,
            query: 'python asyncio guide'
        }
    });

    const searchContent = JSON.parse(searchRes.result.content[0].text);
    console.log(JSON.stringify(searchContent, null, 2));

    // PHASE 3: USER PREFS
    console.log('\n--- PHASE 3: USER PREFS ---');
    const summRes = await sendRequest('tools/call', {
        name: 'memory_summarize',
        arguments: { project_id: PROJECT_ID }
    });
    console.log(JSON.stringify(JSON.parse(summRes.result.content[0].text), null, 2));

    // PHASE 4: QUARANTINE
    console.log('\n--- PHASE 4: SELF HEALING (QUARANTINE) ---');
    // Upsert bad item
    await sendRequest('tools/call', {
        name: 'memory_upsert',
        arguments: {
            items: [{
                title: "DANGEROUS CMD",
                content: "rm -rf / works best",
                type: "runbook",
                tags: ["danger"],
                project_id: PROJECT_ID
            }]
        }
    });

    // Search to get ID
    const badSearch = await sendRequest('tools/call', {
        name: 'memory_search',
        arguments: { project_id: PROJECT_ID, query: "rm -rf / works best" }
    });
    const badId = JSON.parse(badSearch.result.content[0].text).results[0].id;
    console.log('Bad Item ID:', badId);

    // Feedback Wrong
    await sendRequest('tools/call', {
        name: 'memory_feedback',
        arguments: { id: badId, label: "wrong", notes: "dangerous" }
    });

    // Maintain Prune
    await sendRequest('tools/call', {
        name: 'memory_maintain',
        arguments: { project_id: PROJECT_ID, mode: "apply", actions: ["prune"] }
    });

    // Search again
    const checkQuarantine = await sendRequest('tools/call', {
        name: 'memory_search',
        arguments: { project_id: PROJECT_ID, query: "rm -rf / works best" }
    });
    console.log(JSON.stringify(JSON.parse(checkQuarantine.result.content[0].text), null, 2));

    // PHASE 5: AUTO DELETE
    console.log('\n--- PHASE 5: AUTO DELETE ---');
    // Error count 2
    await sendRequest('tools/call', {
        name: 'memory_feedback',
        arguments: { id: badId, label: "wrong", notes: "e2" }
    });
    // Error count 3
    await sendRequest('tools/call', {
        name: 'memory_feedback',
        arguments: { id: badId, label: "wrong", notes: "e3" }
    });

    // Maintain Prune (Trigger Delete)
    const deleteRes = await sendRequest('tools/call', {
        name: 'memory_maintain',
        arguments: { project_id: PROJECT_ID, mode: "apply", actions: ["prune"] }
    });
    console.log(JSON.stringify(JSON.parse(deleteRes.result.content[0].text), null, 2));

    // Get Item
    const getRes = await sendRequest('tools/call', {
        name: 'memory_get',
        arguments: { id: badId }
    });
    console.log(JSON.stringify(JSON.parse(getRes.result.content[0].text), null, 2));

    // PHASE 6: LOOP BREAKER
    console.log('\n--- PHASE 6: LOOP BREAKER ---');
    // Loopbreak
    await sendRequest('tools/call', {
        name: 'memory_maintain',
        arguments: { project_id: PROJECT_ID, mode: "apply", actions: ["loopbreak"] }
    });
    // Summarize
    const loopSum = await sendRequest('tools/call', {
        name: 'memory_summarize',
        arguments: { project_id: PROJECT_ID }
    });
    console.log(JSON.stringify(JSON.parse(loopSum.result.content[0].text), null, 2));

    process.exit(0);
}

runAudit().catch(e => {
    console.error(e);
    process.exit(1);
});
