-- SQLite Schema for MCP Memory Server
-- Uses WAL mode and FTS5 for full-text search

-- Enable WAL mode for better concurrency
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 30000;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -64000; -- 64MB cache

-- Main memory items table
CREATE TABLE IF NOT EXISTS memory_items (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'local-user',
    project_id TEXT NOT NULL DEFAULT 'default',
    type TEXT NOT NULL DEFAULT 'fact' CHECK(type IN ('fact', 'state', 'decision', 'runbook', 'episode')),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT DEFAULT '[]', -- JSON array
    embedding TEXT DEFAULT NULL, -- JSON array of floats
    verified INTEGER DEFAULT 0, -- Boolean as integer
    confidence REAL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
    usefulness_score REAL DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    version INTEGER DEFAULT 1,
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'quarantined', 'deprecated', 'deleted')),
    status_reason TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    last_used_at TEXT DEFAULT (datetime('now')),
    provenance_json TEXT DEFAULT '{}',
    content_hash TEXT NOT NULL
);

-- Idempotency constraint (partial index not supported, use trigger)
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_idempotency 
    ON memory_items(tenant_id, project_id, type, content_hash) 
    WHERE status != 'deleted';

-- Memory links table
CREATE TABLE IF NOT EXISTS memory_links (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
    to_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
    relation TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    
    UNIQUE(from_id, to_id, relation)
);

-- Audit log table
CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    trace_id TEXT NOT NULL,
    ts TEXT DEFAULT (datetime('now')),
    tool_name TEXT NOT NULL,
    request_json TEXT NOT NULL,
    response_json TEXT,
    project_id TEXT,
    tenant_id TEXT DEFAULT 'local-user'
);

-- Mistakes table for loop breaker
CREATE TABLE IF NOT EXISTS mistakes (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'local-user',
    project_id TEXT NOT NULL DEFAULT 'default',
    signature TEXT NOT NULL,
    count INTEGER DEFAULT 1,
    severity TEXT DEFAULT 'medium',
    last_seen_at TEXT DEFAULT (datetime('now')),
    notes_json TEXT DEFAULT '[]',
    
    UNIQUE(tenant_id, project_id, signature)
);

-- Version history for rollback protection
CREATE TABLE IF NOT EXISTS memory_items_history (
    history_id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT,
    content_hash TEXT,
    usefulness_score REAL,
    updated_at TEXT,
    saved_at TEXT DEFAULT (datetime('now')),
    reason TEXT DEFAULT 'pre_update'
);

CREATE INDEX IF NOT EXISTS idx_history_item ON memory_items_history(item_id);
CREATE INDEX IF NOT EXISTS idx_history_saved ON memory_items_history(saved_at DESC);

-- Regular indexes
CREATE INDEX IF NOT EXISTS idx_memory_items_project ON memory_items(project_id);
CREATE INDEX IF NOT EXISTS idx_memory_items_tenant_project ON memory_items(tenant_id, project_id);
CREATE INDEX IF NOT EXISTS idx_memory_items_type ON memory_items(type);
CREATE INDEX IF NOT EXISTS idx_memory_items_status ON memory_items(status);
CREATE INDEX IF NOT EXISTS idx_memory_items_content_hash ON memory_items(content_hash);
CREATE INDEX IF NOT EXISTS idx_memory_items_updated ON memory_items(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_trace ON audit_log(trace_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_project ON audit_log(project_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts DESC);

CREATE INDEX IF NOT EXISTS idx_memory_links_from ON memory_links(from_id);
CREATE INDEX IF NOT EXISTS idx_memory_links_to ON memory_links(to_id);

CREATE INDEX IF NOT EXISTS idx_mistakes_project ON mistakes(project_id);
CREATE INDEX IF NOT EXISTS idx_mistakes_signature ON mistakes(signature);

-- FTS5 virtual table for full-text search (standalone, no content-sync)
-- Standalone FTS gives full control over indexed content
-- Only active items are indexed; deleted/quarantined are excluded
CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_fts USING fts5(
    id UNINDEXED,
    title,
    content
);

-- Triggers to keep FTS in sync (status-aware)
CREATE TRIGGER IF NOT EXISTS memory_items_ai AFTER INSERT ON memory_items
WHEN NEW.status = 'active'
BEGIN
    INSERT INTO memory_items_fts(id, title, content) 
    VALUES (NEW.id, NEW.title, NEW.content);
END;

CREATE TRIGGER IF NOT EXISTS memory_items_ad AFTER DELETE ON memory_items BEGIN
    DELETE FROM memory_items_fts WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS memory_items_au AFTER UPDATE ON memory_items BEGIN
    DELETE FROM memory_items_fts WHERE id = OLD.id;
    INSERT INTO memory_items_fts(id, title, content) 
    SELECT NEW.id, NEW.title, NEW.content
    WHERE NEW.status = 'active';
END;

-- Trigger for updated_at
CREATE TRIGGER IF NOT EXISTS trigger_update_memory_items 
    AFTER UPDATE ON memory_items
    FOR EACH ROW
    WHEN OLD.updated_at = NEW.updated_at
BEGIN
    UPDATE memory_items SET updated_at = datetime('now') WHERE id = NEW.id;
END;
