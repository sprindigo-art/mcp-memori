-- Audit SQL for maintenance operations
-- These queries are used by memory.maintain tool

-- Count items by status
SELECT status, COUNT(*) as count FROM memory_items 
WHERE project_id = ? AND tenant_id = ?
GROUP BY status;

-- Find potential duplicates (same content hash)
SELECT content_hash, COUNT(*) as dup_count, GROUP_CONCAT(id) as ids
FROM memory_items 
WHERE status != 'deleted' AND project_id = ?
GROUP BY content_hash 
HAVING COUNT(*) > 1;

-- Find stale items (not used in X days)
SELECT id, title, last_used_at 
FROM memory_items 
WHERE project_id = ? 
  AND status = 'active'
  AND last_used_at < datetime('now', '-30 days');

-- Find items with high error count
SELECT id, title, error_count, usefulness_score 
FROM memory_items 
WHERE project_id = ? 
  AND status = 'active'
  AND error_count >= ?;

-- Find low usefulness items
SELECT id, title, usefulness_score, error_count 
FROM memory_items 
WHERE project_id = ? 
  AND status = 'active'
  AND usefulness_score < ?;

-- Recent mistakes in project
SELECT * FROM mistakes 
WHERE project_id = ? 
  AND last_seen_at > datetime('now', '-7 days')
ORDER BY count DESC;

-- Contradiction detection (items with conflicting content)
-- This is a placeholder - actual contradiction detection requires semantic analysis
SELECT a.id as id_a, b.id as id_b, a.title as title_a, b.title as title_b
FROM memory_items a
JOIN memory_items b ON a.project_id = b.project_id 
  AND a.id != b.id 
  AND a.type = b.type
  AND a.status = 'active' 
  AND b.status = 'active'
WHERE a.project_id = ?
  AND a.rowid < b.rowid; -- Avoid duplicates
