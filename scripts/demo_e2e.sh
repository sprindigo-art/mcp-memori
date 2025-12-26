#!/bin/bash
# End-to-end demo script
set -e

cd "$(dirname "$0")/.."

echo "========================================"
echo "MCP Memory Server - E2E Demo"
echo "========================================"

# 1. Migrate database
echo ""
echo "Step 1: Migrating database..."
npm run db:migrate

# 2. Seed sample data
echo ""
echo "Step 2: Seeding sample data..."
node scripts/seed_sample.js

# 3. Test upsert via direct tool call
echo ""
echo "Step 3: Testing memory.upsert..."
node -e "
import { initDb, closeDb } from './src/db/index.js';
import { execute as upsert } from './src/mcp/tools/memory.upsert.js';

await initDb();

const result = await upsert({
  items: [
    {
      type: 'fact',
      project_id: 'e2e-test',
      title: 'E2E Test Fact',
      content: 'This fact was created during E2E testing.',
      tags: ['e2e', 'test'],
      verified: false
    },
    {
      type: 'decision',
      project_id: 'e2e-test',
      title: 'E2E Test Decision',
      content: 'Decided to run comprehensive E2E tests.',
      tags: ['e2e', 'decision'],
      verified: true
    },
    {
      type: 'state',
      project_id: 'e2e-test',
      title: 'E2E Current State',
      content: 'E2E testing in progress. All systems nominal.',
      tags: ['e2e', 'status'],
      verified: true
    }
  ]
});

console.log('Upsert result:', JSON.stringify(result, null, 2));
await closeDb();
"

# 4. Test search
echo ""
echo "Step 4: Testing memory.search..."
node -e "
import { initDb, closeDb } from './src/db/index.js';
import { execute as search } from './src/mcp/tools/memory.search.js';

await initDb();

const result = await search({
  query: 'E2E test decision',
  project_id: 'e2e-test',
  limit: 5
});

console.log('Search result:', JSON.stringify(result, null, 2));
await closeDb();
"

# 5. Test summarize
echo ""
echo "Step 5: Testing memory.summarize..."
node -e "
import { initDb, closeDb } from './src/db/index.js';
import { execute as summarize } from './src/mcp/tools/memory.summarize.js';

await initDb();

const result = await summarize({
  project_id: 'e2e-test'
});

console.log('Summarize result:', JSON.stringify(result, null, 2));
await closeDb();
"

# 6. Simulate restart (close and reopen DB)
echo ""
echo "Step 6: Simulating server restart..."
sleep 1

# 7. Test summarize again (should be consistent)
echo ""
echo "Step 7: Testing summarize after restart..."
node -e "
import { initDb, closeDb } from './src/db/index.js';
import { execute as summarize } from './src/mcp/tools/memory.summarize.js';

await initDb();

const result = await summarize({
  project_id: 'e2e-test'
});

console.log('Summarize after restart:', JSON.stringify(result, null, 2));

// Verify consistency
if (result.summary.state_latest && result.summary.state_latest.title === 'E2E Current State') {
  console.log('✓ State persistence verified!');
} else {
  console.log('✗ State persistence FAILED!');
  process.exit(1);
}

await closeDb();
"

# 8. Test feedback
echo ""
echo "Step 8: Testing memory.feedback..."
node -e "
import { initDb, closeDb, query } from './src/db/index.js';
import { execute as feedback } from './src/mcp/tools/memory.feedback.js';

await initDb();

// Get an item ID
const items = await query(
  \"SELECT id FROM memory_items WHERE project_id = 'e2e-test' LIMIT 1\",
  []
);

if (items.length > 0) {
  const result = await feedback({
    id: items[0].id,
    label: 'useful',
    notes: 'E2E test feedback'
  });
  console.log('Feedback result:', JSON.stringify(result, null, 2));
}

await closeDb();
"

# 9. Test maintain
echo ""
echo "Step 9: Testing memory.maintain (dry_run)..."
node -e "
import { initDb, closeDb } from './src/db/index.js';
import { execute as maintain } from './src/mcp/tools/memory.maintain.js';

await initDb();

const result = await maintain({
  project_id: 'e2e-test',
  mode: 'dry_run',
  actions: ['dedup', 'conflict', 'prune', 'loopbreak']
});

console.log('Maintain result:', JSON.stringify(result, null, 2));
await closeDb();
"

# 10. Cleanup test data
echo ""
echo "Step 10: Cleaning up E2E test data..."
node -e "
import { initDb, closeDb, query } from './src/db/index.js';

await initDb();
await query(\"DELETE FROM memory_items WHERE project_id = 'e2e-test'\", []);
await query(\"DELETE FROM audit_log WHERE project_id = 'e2e-test'\", []);
console.log('Cleanup complete.');
await closeDb();
"

echo ""
echo "========================================"
echo "E2E Demo COMPLETED SUCCESSFULLY!"
echo "========================================"
