# MCP Memory Server v2.0

Production-grade MCP Memory Server untuk agent AI dengan kemampuan:
- **Ingat lintas sesi** (persisten SQLite/PostgreSQL)
- **Tidak mengulang dari nol** (state preservation)
- **Recall akurat** (hybrid search: keyword + vector + recency)
- **Self-healing** (auto-quarantine memori buruk)
- **Loop breaker** (deteksi dan cegah kesalahan berulang)
- **Concurrency-safe** (3 AI bisa berjalan bersamaan)
- **Tanpa API key** (embedding lokal via ollama, atau keyword-only)

---

## 🚀 v2.0 ENHANCEMENTS - 5 LAYERS

### LAYER 1: Semantic Power (Configurable Hybrid Search)
- `EMBEDDING_MODE`: `keyword_only` | `hybrid` | `vector_only`
- Default tetap `keyword_only` untuk stabilitas dan determinisme
- Configurable score weights per mode
- Auto-fallback ke keyword_only jika vector gagal

**Score Formula:**
```javascript
// keyword_only (default, deterministic)
score = keyword * 0.75 + recency * 0.25

// hybrid (balanced)
score = keyword * 0.5 + vector * 0.3 + recency * 0.2

// vector_only (semantic focus)
score = vector * 0.8 + recency * 0.2
```

### LAYER 2: Lightweight Knowledge Graph
- Relasi antar memori: `causes`, `depends_on`, `contradicts`, `supersedes`, `related_to`
- Multi-hop traversal untuk context enrichment
- Digunakan saat summarize, conflict detection, dan loop breaker

### LAYER 3: Temporal Intelligence
- `temporal_type`: `event` | `state` | `rule` | `preference`
- Decay berbeda per tipe:
  - `event`: decay cepat (0.15) - events become old quickly
  - `state`: decay normal (0.1)
  - `rule`: decay lambat (0.03) - rules persist
  - `preference`: decay sangat lambat (0.02) - preferences almost permanent

### LAYER 4: Intelligence Governance
- **Guardrails Manager**: Explicit guardrail untuk blocking/suppressing
- **Auto-guardrail**: Dari repeated mistakes
- `meta.forensic.governance_state` di setiap response:
  - `quarantined_count`, `quarantined_ids`
  - `deleted_count`, `recent_deleted_ids`
  - `guardrails_active`
  - `suppressed_memory_ids`

### LAYER 5: Cross-Model Intelligence
- Provenance tracking: `model_id`, `persona`, `confidence`, `session_id`
- Conflict detection antar model
- `meta.forensic.cross_model` summary

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Setup environment
cp .env.example .env

# 3. Migrate database
npm run db:migrate

# 4. Apply v2.0 schema upgrade
sqlite3 data/memory.db < src/db/schema.upgrade.sql

# 5. Run tests
npm test
node scripts/test_layers.cjs  # Test 5 layers

# 6. Start server
npm start
```

## 7 Tools

### 1. memory_search
Cari memori dengan hybrid search (vector + keyword + recency).

```json
{
  "query": "database architecture",
  "project_id": "my-project",
  "types": ["decision", "fact"],
  "tags": ["architecture"],
  "limit": 10,
  "override_quarantine": false
}
```

**Response v2.0:**
```json
{
  "results": [{
    "id": "uuid",
    "type": "decision",
    "title": "Use PostgreSQL",
    "snippet": "Decided to use PostgreSQL...",
    "final_score": 0.85,
    "score_breakdown": {
      "keyword": 0.7,
      "vector": 0,
      "recency": 0.8,
      "verified_bonus": 0.1,
      "temporal_type": "rule"
    },
    "status": "active",
    "verified": true,
    "confidence": 0.9,
    "version": 2
  }],
  "excluded": [{
    "id": "bad-uuid",
    "title": "Outdated",
    "reason": "quarantined"
  }],
  "meta": {
    "trace_id": "uuid",
    "mode": "keyword_only",
    "weights_used": {"keyword": 0.75, "vector": 0, "recency": 0.25},
    "forensic": {
      "db_backend": "sqlite",
      "embedding_mode": "keyword_only",
      "score_weights": {...},
      "temporal_config": {...},
      "governance_state": {
        "quarantined_count": 1,
        "guardrails_active": [],
        "suppressed_memory_ids": []
      },
      "cross_model": {
        "models_detected": ["claude", "gpt-4"],
        "pending_conflicts": 0
      }
    }
  }
}
```

### 2. memory_get
Ambil detail lengkap satu memori.

```json
{
  "id": "memory-uuid"
}
```

### 3. memory_upsert
Simpan atau update memori (idempotent).

```json
{
  "items": [{
    "type": "decision",
    "project_id": "my-project",
    "title": "Use Docker",
    "content": "Decided to containerize with Docker for consistency.",
    "tags": ["devops", "docker", "user_preference"],
    "verified": true,
    "confidence": 0.9,
    "provenance_json": {
      "model_id": "claude-3",
      "persona": "architect",
      "session_id": "abc123"
    }
  }]
}
```

### 4. memory_forget
Soft-delete memori.

```json
{
  "id": "memory-uuid",
  "reason": "Outdated information"
}
```

### 5. memory_summarize
Ringkasan project dengan user_preferences.

```json
{
  "project_id": "my-project"
}
```

**Response includes:**
- `state_latest`
- `key_decisions`
- `runbooks_top`
- `user_preferences` (items dengan tag `user_preference`)
- `guardrails` (active peringatan)
- `excluded_items` (quarantined dengan alasan)

### 6. memory_feedback
Beri feedback pada memori.

```json
{
  "id": "memory-uuid",
  "label": "useful|not_relevant|wrong",
  "notes": "Optional explanation"
}
```

### 7. memory_maintain
Maintenance komprehensif.

```json
{
  "project_id": "my-project",
  "mode": "dry_run|apply",
  "actions": ["dedup", "conflict", "prune", "compact", "loopbreak"],
  "policy": {
    "max_age_days": 90,
    "min_usefulness": -2.0,
    "max_error_count": 3,
    "keep_last_n_episodes": 10,
    "quarantine_on_wrong_threshold": 1,
    "delete_on_wrong_threshold": 3
  }
}
```

## Memory Types

| Type | Description | Temporal Type | Safe Delete |
|------|-------------|---------------|-------------|
| `fact` | Fakta/informasi | state | ✓ |
| `fact` + tag `user_preference` | Preferensi user | preference | ✓ |
| `state` | Status terkini project | state | ✗ (supersede) |
| `decision` | Keputusan arsitektur/teknis | rule | ✗ (deprecated) |
| `runbook` | How-to/prosedur | rule | ✓ |
| `episode` | Log sesi/aktivitas | event | ✓ |

## Status Flow

```
active → quarantined → deleted
       ↘ deprecated ↗
```

- **active**: Normal, searchable
- **quarantined**: Error >= threshold, hidden dari search (kecuali override)
- **deprecated**: Superseded, score penalty 0.7x
- **deleted**: Soft-deleted, never returned

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_URL` | - | PostgreSQL connection string |
| `SQLITE_PATH` | `./data/memory.db` | SQLite database path |
| `EMBEDDING_MODE` | `keyword_only` | `keyword_only`, `hybrid`, atau `vector_only` |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama endpoint |
| `OLLAMA_MODEL` | `nomic-embed-text` | Embedding model |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug` |

## Keunggulan vs Sistem AI Memory Lain

| Feature | MCP Memory v2.0 | Mem0 | Zep | MemGPT |
|---------|-----------------|------|-----|--------|
| Self-Healing | ✅ Auto quarantine + delete | ❌ | ❌ | ❌ |
| Loop Breaker | ✅ Guardrails injection | ❌ | ❌ | ❌ |
| Forensic Audit | ✅ meta.forensic setiap response | ⚠️ Partial | ⚠️ Partial | ❌ |
| Temporal Intelligence | ✅ Type-based decay | ⚠️ Partial | ✅ Excellent | ⚠️ Limited |
| Cross-Model | ✅ Conflict detection | ❌ | ❌ | ❌ |
| Latency | ✅ 7-20ms | 1.4s p95 | Low | High |
| Determinism | ✅ Keyword-only default | ❌ | ❌ | ❌ |

## MCP Configuration

Add to your MCP config:

```json
{
  "mcpServers": {
    "mcp-memori": {
      "command": "node",
      "args": ["/path/to/mcp-memori/src/server.js"],
      "env": {
        "SQLITE_PATH": "/path/to/memory.db",
        "EMBEDDING_MODE": "keyword_only"
      }
    }
  }
}
```

## License

MIT
