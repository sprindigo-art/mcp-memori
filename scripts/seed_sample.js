#!/usr/bin/env node
/**
 * Seed sample data for testing
 * @module scripts/seed_sample
 */
import { initDb, closeDb, query } from '../src/db/index.js';
import { contentHash } from '../src/utils/hash.js';
import { now } from '../src/utils/time.js';
import { v4 as uuidv4 } from 'uuid';

const TENANT_ID = 'local-user';
const PROJECT_ID = 'test-project';

// Sample memory items
const sampleItems = [
    // States
    {
        type: 'state',
        title: 'Current Project State',
        content: `## Progress
- Phase 1: Complete
- Phase 2: In progress (70%)
- Phase 3: Not started

## Current Focus
Implementing hybrid search with keyword + vector support.

## Blockers
None currently.`,
        tags: ['progress', 'status'],
        verified: true
    },

    // Decisions
    {
        type: 'decision',
        title: 'Use SQLite as Primary Database',
        content: `Decided to use SQLite with WAL mode as the primary database for local development.
    
Rationale:
1. Zero configuration required
2. WAL mode provides good concurrency
3. FTS5 for full-text search
4. Easy backup (single file)

Alternatives considered: PostgreSQL (requires setup), LevelDB (no SQL).`,
        tags: ['architecture', 'database'],
        verified: true
    },
    {
        type: 'decision',
        title: 'Implement Hybrid Search',
        content: `Decided to implement hybrid search combining keyword and vector search.

Scoring formula:
- With embeddings: 0.55*vector + 0.25*keyword + 0.10*recency + 0.10*verified
- Keyword-only: 0.75*keyword + 0.25*recency + 0.10*verified

This balances semantic similarity with exact match and freshness.`,
        tags: ['search', 'algorithm'],
        verified: true
    },

    // Runbooks
    {
        type: 'runbook',
        title: 'How to Add New Memory Item',
        content: `1. Call memory.upsert with item details
2. System will auto-generate content hash
3. If duplicate exists, version will increment
4. Embedding generated if ollama available
5. Verify with memory.get to confirm`,
        tags: ['howto', 'upsert'],
        verified: true
    },
    {
        type: 'runbook',
        title: 'How to Debug Search Issues',
        content: `1. Check meta.mode in response (local_embeddings or keyword_only)
2. Examine keyword_score and vector_score breakdown
3. Verify item status is 'active'
4. Check if item has proper tags
5. Run memory.maintain to fix duplicates`,
        tags: ['howto', 'debug', 'search'],
        verified: true
    },

    // Facts
    {
        type: 'fact',
        title: 'MCP Protocol Version',
        content: 'Using MCP protocol version 2024-11-05 for server implementation.',
        tags: ['protocol', 'version'],
        verified: true
    },
    {
        type: 'fact',
        title: 'Supported Memory Types',
        content: 'System supports 5 memory types: fact, state, decision, runbook, episode.',
        tags: ['types', 'schema'],
        verified: true
    },
    {
        type: 'fact',
        title: 'TODO: Add vector index optimization',
        content: 'Need to add HNSW index for faster vector search when using PostgreSQL with pgvector.',
        tags: ['todo', 'optimization'],
        verified: false
    },

    // Episodes
    {
        type: 'episode',
        title: 'Initial Setup Session',
        content: `Session: 2024-12-25

Actions:
1. Created database schema
2. Implemented 7 MCP tools
3. Added hybrid search
4. Tested concurrency

Outcome: Basic system working.`,
        tags: ['session', 'setup'],
        verified: true
    },
    {
        type: 'episode',
        title: 'Debugging Session - FTS Issues',
        content: `Session: 2024-12-26

Problem: FTS5 not returning expected results

Investigation:
1. Checked trigger sync
2. Verified FTS table populated
3. Found issue with tokenizer

Solution: Use proper FTS5 query syntax with quotes.`,
        tags: ['session', 'debug', 'fts'],
        verified: true
    }
];

// Bad items for testing quarantine/delete
const badItems = [
    {
        type: 'fact',
        title: 'Wrong Information',
        content: 'This is intentionally wrong information for testing feedback system.',
        tags: ['test', 'wrong'],
        verified: false,
        error_count: 2,
        status: 'quarantined',
        status_reason: 'Marked wrong multiple times'
    }
];

async function seed() {
    console.log('Seeding sample data...');

    await initDb();

    // Clear existing test data
    await query(
        `DELETE FROM memory_items WHERE project_id = ?`,
        [PROJECT_ID]
    );
    await query(
        `DELETE FROM mistakes WHERE project_id = ?`,
        [PROJECT_ID]
    );

    // Insert sample items
    for (const item of sampleItems) {
        const id = uuidv4();
        const hash = contentHash(item.content);

        await query(
            `INSERT INTO memory_items (
        id, tenant_id, project_id, type, title, content, tags,
        verified, confidence, content_hash, created_at, updated_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                id, TENANT_ID, PROJECT_ID, item.type, item.title, item.content,
                JSON.stringify(item.tags), item.verified ? 1 : 0, 0.8, hash,
                now(), now(), now()
            ]
        );

        console.log(`  Created: ${item.type} - ${item.title}`);
    }

    // Insert bad items
    for (const item of badItems) {
        const id = uuidv4();
        const hash = contentHash(item.content);

        await query(
            `INSERT INTO memory_items (
        id, tenant_id, project_id, type, title, content, tags,
        verified, confidence, error_count, status, status_reason,
        content_hash, created_at, updated_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                id, TENANT_ID, PROJECT_ID, item.type, item.title, item.content,
                JSON.stringify(item.tags), item.verified ? 1 : 0, 0.3,
                item.error_count, item.status, item.status_reason, hash,
                now(), now(), now()
            ]
        );

        console.log(`  Created (${item.status}): ${item.type} - ${item.title}`);
    }

    await closeDb();

    console.log(`\nSeeded ${sampleItems.length + badItems.length} items to project: ${PROJECT_ID}`);
}

seed().catch(err => {
    console.error('Seed failed:', err);
    process.exit(1);
});
