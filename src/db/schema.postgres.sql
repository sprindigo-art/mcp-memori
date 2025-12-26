-- PostgreSQL Schema for MCP Memory Server
-- Requires: PostgreSQL 14+ with pgvector extension (optional)

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
-- CREATE EXTENSION IF NOT EXISTS vector; -- Uncomment if pgvector available

-- Memory item types
CREATE TYPE memory_type AS ENUM ('fact', 'state', 'decision', 'runbook', 'episode');

-- Memory status
CREATE TYPE memory_status AS ENUM ('active', 'quarantined', 'deprecated', 'deleted');

-- Main memory items table
CREATE TABLE IF NOT EXISTS memory_items (
    id TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::text,
    tenant_id TEXT NOT NULL DEFAULT 'local-user',
    project_id TEXT NOT NULL DEFAULT 'default',
    type memory_type NOT NULL DEFAULT 'fact',
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    tags JSONB DEFAULT '[]'::jsonb,
    embedding FLOAT8[] DEFAULT NULL,
    -- embedding vector(384) DEFAULT NULL, -- Uncomment for pgvector
    verified BOOLEAN DEFAULT false,
    confidence FLOAT DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
    usefulness_score FLOAT DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    version INTEGER DEFAULT 1,
    status memory_status DEFAULT 'active',
    status_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    provenance_json JSONB DEFAULT '{}'::jsonb,
    content_hash TEXT NOT NULL,
    
    -- Idempotency constraint: same content for same tenant/project/type cannot exist twice (unless deleted)
    CONSTRAINT unique_content_per_context UNIQUE (tenant_id, project_id, type, content_hash)
);

-- Memory links table
CREATE TABLE IF NOT EXISTS memory_links (
    id TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::text,
    from_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
    to_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
    relation TEXT NOT NULL, -- 'supersedes', 'contradicts', 'relates', 'supports'
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT unique_link UNIQUE (from_id, to_id, relation)
);

-- Audit log table
CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::text,
    trace_id TEXT NOT NULL,
    ts TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    tool_name TEXT NOT NULL,
    request_json JSONB NOT NULL,
    response_json JSONB, -- Redacted version
    project_id TEXT,
    tenant_id TEXT DEFAULT 'local-user'
);

-- Mistakes table for loop breaker
CREATE TABLE IF NOT EXISTS mistakes (
    id TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::text,
    tenant_id TEXT NOT NULL DEFAULT 'local-user',
    project_id TEXT NOT NULL DEFAULT 'default',
    signature TEXT NOT NULL, -- Hash of error pattern
    count INTEGER DEFAULT 1,
    severity TEXT DEFAULT 'medium', -- low, medium, high, critical
    last_seen_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    notes_json JSONB DEFAULT '[]'::jsonb,
    
    CONSTRAINT unique_mistake_signature UNIQUE (tenant_id, project_id, signature)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_memory_items_project ON memory_items(project_id);
CREATE INDEX IF NOT EXISTS idx_memory_items_tenant_project ON memory_items(tenant_id, project_id);
CREATE INDEX IF NOT EXISTS idx_memory_items_type ON memory_items(type);
CREATE INDEX IF NOT EXISTS idx_memory_items_status ON memory_items(status);
CREATE INDEX IF NOT EXISTS idx_memory_items_content_hash ON memory_items(content_hash);
CREATE INDEX IF NOT EXISTS idx_memory_items_updated ON memory_items(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_items_tags ON memory_items USING GIN(tags);

-- Full-text search index
CREATE INDEX IF NOT EXISTS idx_memory_items_fts ON memory_items 
    USING GIN(to_tsvector('english', title || ' ' || content));

CREATE INDEX IF NOT EXISTS idx_audit_log_trace ON audit_log(trace_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_project ON audit_log(project_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts DESC);

CREATE INDEX IF NOT EXISTS idx_memory_links_from ON memory_links(from_id);
CREATE INDEX IF NOT EXISTS idx_memory_links_to ON memory_links(to_id);

CREATE INDEX IF NOT EXISTS idx_mistakes_project ON mistakes(project_id);
CREATE INDEX IF NOT EXISTS idx_mistakes_signature ON mistakes(signature);

-- Update trigger for updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_memory_items ON memory_items;
CREATE TRIGGER trigger_update_memory_items
    BEFORE UPDATE ON memory_items
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();
