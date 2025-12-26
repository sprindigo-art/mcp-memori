-- MCP Memory Upgrade Schema v2.0
-- Layer 1-5 Enhancements

-- =====================================================
-- LAYER 3: Temporal Intelligence - Add temporal_type column
-- =====================================================
ALTER TABLE memory_items ADD COLUMN temporal_type TEXT DEFAULT 'state' 
    CHECK(temporal_type IN ('event', 'rule', 'preference', 'state'));

-- =====================================================
-- LAYER 2: Lightweight Knowledge Graph - Enhanced relations table
-- =====================================================
-- Relations already exist, but add relation_type constraint
-- relation types: causes, depends_on, contradicts, supersedes, related_to

-- Add weight/strength to relations for graph traversal
ALTER TABLE memory_links ADD COLUMN weight REAL DEFAULT 1.0;
ALTER TABLE memory_links ADD COLUMN metadata_json TEXT DEFAULT '{}';

-- Index for efficient graph queries
CREATE INDEX IF NOT EXISTS idx_memory_links_relation ON memory_links(relation);

-- =====================================================
-- LAYER 4: Intelligence Governance - Enhanced mistakes tracking
-- =====================================================
ALTER TABLE mistakes ADD COLUMN severity_score REAL DEFAULT 0.5;
ALTER TABLE mistakes ADD COLUMN auto_quarantine INTEGER DEFAULT 0;
ALTER TABLE mistakes ADD COLUMN related_ids_json TEXT DEFAULT '[]';

-- Add guardrails table for explicit guardrail management
CREATE TABLE IF NOT EXISTS guardrails (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'local-user',
    project_id TEXT NOT NULL DEFAULT 'default',
    rule_type TEXT NOT NULL CHECK(rule_type IN ('block', 'warn', 'suppress')),
    pattern_signature TEXT NOT NULL,
    description TEXT NOT NULL,
    suppress_ids_json TEXT DEFAULT '[]',
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT,
    
    UNIQUE(tenant_id, project_id, pattern_signature)
);

CREATE INDEX IF NOT EXISTS idx_guardrails_project ON guardrails(tenant_id, project_id, active);

-- =====================================================
-- LAYER 5: Cross-Model Intelligence - Enhanced provenance
-- =====================================================
-- provenance_json already exists, but add model_conflicts table
CREATE TABLE IF NOT EXISTS model_conflicts (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'local-user',
    project_id TEXT NOT NULL DEFAULT 'default',
    item_id_a TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
    item_id_b TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
    conflict_type TEXT NOT NULL CHECK(conflict_type IN ('interpretation', 'contradiction', 'version')),
    resolution_status TEXT DEFAULT 'pending' CHECK(resolution_status IN ('pending', 'resolved', 'ignored')),
    resolution_notes TEXT,
    detected_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT,
    
    UNIQUE(item_id_a, item_id_b)
);

CREATE INDEX IF NOT EXISTS idx_model_conflicts_project ON model_conflicts(tenant_id, project_id, resolution_status);
