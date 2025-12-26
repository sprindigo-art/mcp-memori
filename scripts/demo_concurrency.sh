#!/bin/bash
# Concurrency demo script - tests 3 parallel workers
set -e

cd "$(dirname "$0")/.."

echo "========================================"
echo "MCP Memory Server - Concurrency Demo"
echo "========================================"

# 1. Migrate database
echo ""
echo "Step 1: Migrating database..."
npm run db:migrate

# 2. Create concurrency test
echo ""
echo "Step 2: Running 3 parallel upsert workers..."

# Worker script
WORKER_SCRIPT='
import { initDb, closeDb, query } from "./src/db/index.js";
import { execute as upsert } from "./src/mcp/tools/memory.upsert.js";

const workerId = process.argv[2];

await initDb();

try {
  // All workers try to upsert the SAME item
  const result = await upsert({
    items: [{
      type: "fact",
      project_id: "concurrency-test",
      title: "Shared Fact",
      content: "This is a shared fact that all workers try to create.",
      tags: ["concurrency", "test"],
      verified: true
    }]
  });
  
  console.log(`Worker ${workerId}: ${JSON.stringify(result.upserted[0])}`);
} catch (err) {
  console.log(`Worker ${workerId} error: ${err.message}`);
}

await closeDb();
'

# Run 3 workers in parallel
node -e "$WORKER_SCRIPT" -- 1 &
PID1=$!

node -e "$WORKER_SCRIPT" -- 2 &
PID2=$!

node -e "$WORKER_SCRIPT" -- 3 &
PID3=$!

# Wait for all workers
wait $PID1
wait $PID2
wait $PID3

echo ""
echo "Step 3: Verifying results..."

# Verify only 1 item exists
node -e "
import { initDb, closeDb, query } from './src/db/index.js';

await initDb();

const items = await query(
  \"SELECT id, version, title FROM memory_items WHERE project_id = 'concurrency-test' AND status = 'active'\",
  []
);

console.log('Items found:', items.length);
items.forEach(i => console.log('  -', i.id, 'v' + i.version, i.title));

if (items.length === 1) {
  console.log('');
  console.log('✓ Concurrency test PASSED! Only 1 item created.');
  console.log('  Final version:', items[0].version);
} else {
  console.log('');
  console.log('✗ Concurrency test FAILED! Expected 1 item, got', items.length);
  process.exit(1);
}

// Cleanup
await query(\"DELETE FROM memory_items WHERE project_id = 'concurrency-test'\", []);
await query(\"DELETE FROM audit_log WHERE project_id = 'concurrency-test'\", []);

await closeDb();
"

echo ""
echo "========================================"
echo "Concurrency Demo COMPLETED SUCCESSFULLY!"
echo "========================================"
