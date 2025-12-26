const { spawn } = require('child_process');
const path = require('path');

const SERVER_PATH = path.join(__dirname, '../src/server.js');
const cp = spawn('node', [SERVER_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });

console.log('Starting Test...');

let buffer = '';
cp.stdout.on('data', (d) => {
    buffer += d.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    lines.forEach(line => {
        if (!line.trim()) return;
        try {
            const msg = JSON.parse(line);
            console.log('\n[SERVER RESPONSE]:');
            console.log(JSON.stringify(msg, null, 2));

            // Flow logic
            if (msg.result && msg.result.capabilities) { // Initialize response
                console.log('-> Sending initialized notification...');
                cp.stdin.write(JSON.stringify({
                    jsonrpc: "2.0",
                    method: "notifications/initialized"
                }) + '\n');

                console.log('-> Sending tools/list...');
                cp.stdin.write(JSON.stringify({
                    jsonrpc: "2.0",
                    id: 2,
                    method: "tools/list",
                    params: {}
                }) + '\n');
            } else if (msg.id === 2 && msg.result.tools) {
                console.log(`-> Received ${msg.result.tools.length} tools. Test OK.`);
                process.exit(0);
            }

        } catch (e) {
            console.error('INVALID JSON line:', line);
        }
    });
});

cp.stderr.on('data', (d) => {
    // Show logs but don't fail, logs are allowed on stderr
    console.log('[LOG]:', d.toString().trim());
});

// 1. Send initialize
console.log('-> Sending initialize...');
cp.stdin.write(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "tester", version: "1.0" }
    }
}) + '\n');

// Timeout
setTimeout(() => {
    console.error('Timeout!');
    cp.kill();
    process.exit(1);
}, 5000);
