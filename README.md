# MCP Memory Server v5.2

Production-grade MCP Memory Server untuk agent AI — **OTAK UTAMA** sistem Janda AI.

**Status:** Production (Feb 21, 2026) | **Items:** 2,487 active | **Links:** 3,170 | **Guardrails:** 17 active | **FTS:** 100% sync (0 ghost)

## Kemampuan Utama
- **Ingat lintas sesi** — persisten SQLite (PostgreSQL supported)
- **Hybrid search** — keyword + vector (sentence-transformers lokal) + recency
- **Self-healing** — auto-quarantine memori buruk, loop breaker
- **Guardrails aktif** — blokir teknik yang sudah gagal, cegah kesalahan berulang
- **Metacognition** — refleksi pola kegagalan/keberhasilan
- **LRU Cache** — response <20ms untuk items yang sering diakses
- **Concurrency-safe** — multi-agent bisa berjalan bersamaan
- **Tanpa API key** — embedding lokal via @xenova/transformers (384-dim)

---

## Arsitektur

```
┌──────────────────────────────────────────────────┐
│              MCP Memory v5.2                     │
├──────────┬──────────┬────────────────────────────┤
│ 10 Tools │ 5 Layers │ 38 Source Files            │
├──────────┴──────────┴────────────────────────────┤
│                                                  │
│  ┌─────────┐  ┌──────────┐  ┌──────────────────┐ │
│  │ Search  │  │  Upsert  │  │  List (NEW v5.2) │ │
│  │ hybrid  │  │ idempot. │  │  browse/filter   │ │
│  │+paginate│  │ +history │  │  +pagination     │ │
│  └────┬────┘  └────┬─────┘  └────────┬─────────┘ │
│       │            │                 │           │
│  ┌────▼────────────▼─────────────────▼────────┐  │
│  │           SQLite (memory.db)               │  │
│  │  Items: 2,487 | Links: 3,170              │  │
│  │  FTS5: standalone (0 ghost) | History: ON  │  │
│  │  Embeddings: 384-dim local                │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌───────────┐  ┌──────────┐  ┌──────────────┐  │
│  │ Guardrails│  │ Governor │  │  Cache        │  │
│  │ 17 active │  │ forensic │  │  LRU 200     │  │
│  │ +prune    │  │ -crossMod│  │              │  │
│  │  protect  │  │  (inline)│  │              │  │
│  └───────────┘  └──────────┘  └──────────────┘  │
└──────────────────────────────────────────────────┘
```

---

## 5 Layers

### Layer 1: Semantic Power (Hybrid Search)
Tiga mode pencarian yang bisa dikonfigurasi:

| Mode | Formula | Use Case |
|------|---------|----------|
| `keyword_only` | keyword×0.75 + recency×0.25 | Deterministic, low latency |
| **`hybrid`** (default) | keyword×0.5 + vector×0.3 + recency×0.2 | **Balanced, recommended** |
| `vector_only` | vector×0.8 + recency×0.2 | Semantic-only |

**Embedding Backend:** `@xenova/transformers` (all-MiniLM-L6-v2, 384-dim)
- Lokal, tanpa API key, tanpa Ollama dependency
- Auto-fallback ke keyword_only jika embedding gagal

### Layer 2: Knowledge Graph
- Relasi antar memori: `causes`, `depends_on`, `contradicts`, `supersedes`, `related_to`
- Multi-hop traversal untuk context enrichment
- 1,315 links aktif di database

### Layer 3: Temporal Intelligence
| Type | Decay Rate | Behavior |
|------|-----------|----------|
| `event` | 0.15 (cepat) | Episode/log cepat usang |
| `state` | 0.10 (normal) | Status project |
| `rule` | 0.03 (lambat) | Decision/runbook bertahan lama |
| `preference` | 0.02 (sangat lambat) | Preferensi hampir permanen |

### Layer 4: Intelligence Governance
- **Guardrails Manager:** blokir/suppress memori berbahaya
- **Auto-guardrail:** dari repeated mistakes (17 rules aktif)
- **Forensic metadata** di setiap response: quarantine count, deleted count, guardrails active
- **Smart scoring:** usefulness_score berbasis success/failure flag

### Layer 5: Cross-Model Intelligence
- Provenance tracking: `model_id`, `persona`, `confidence`, `session_id`
- Conflict detection antar model
- 12 model terdeteksi, 0 konflik aktif

---

## 10 Tools

### 1. `memory_search`
Cari memori dengan hybrid search (vector + keyword + recency). Mendukung pagination dan full content.

```json
{
  "query": "target SQLi exploit",
  "project_id": "janda_workspace",
  "types": ["fact", "episode"],
  "tags": ["credential"],
  "required_tags": ["critical"],
  "limit": 30,
  "offset": 0,
  "full_content": false,
  "allow_relations": false,
  "override_quarantine": false
}
```

**Response includes pagination:** `{ total, offset, limit, returned, has_more }`

### 2. `memory_get`
Ambil detail lengkap satu memori berdasarkan ID. Includes linked items.

```json
{
  "id": "uuid-here"
}
```

### 3. `memory_upsert`
Simpan atau update memori (idempotent, concurrency-safe).

```json
{
  "items": [{
    "type": "episode",
    "project_id": "janda_workspace",
    "title": "[FAILED] SQLi at /login endpoint",
    "content": "Command: sqlmap -u target/login\n## OUTCOME: WAF blocked",
    "tags": ["guardrail", "banned"],
    "success": false,
    "verified": true,
    "confidence": 0.9
  }]
}
```

**Fitur upsert:**
- Title match → update existing (idempotent)
- Fuzzy title match → Jaccard >= 0.6 via FTS-based candidate search (v5.2)
- Content hash → skip jika identik
- **History backup:** content lama otomatis disimpan ke `memory_items_history` sebelum overwrite
- Front-loading embedding: `TITLE | TAGS | OUTCOME | CMD | content`
- Score otomatis: `success:true` = +0.5, `success:false` = -0.5
- Safeguard: mencegah merge [FAILED] dengan [SUCCESS] items
- Format validation: Episode WAJIB punya `Command:` + `## OUTCOME`
- Auto-link ke items terkait
- Maintenance counter: warning setiap 20 upserts

### 4. `memory_forget`
Soft-delete memori dengan alasan. Support bulk delete via selector.

```json
{
  "id": "uuid-here",
  "reason": "Outdated credential"
}
```

### 5. `memory_summarize`
Ringkasan project: state terkini, keputusan, runbooks, guardrails.

```json
{
  "project_id": "janda_workspace",
  "compact": true
}
```

### 6. `memory_feedback`
Beri feedback pada memori (useful/not_relevant/wrong).

```json
{
  "id": "uuid-here",
  "label": "useful",
  "notes": "Credential masih valid"
}
```

### 7. `memory_maintain`
Maintenance komprehensif: dedup, conflict, prune, compact, loopbreak, clean_links, auto_guardrails, archive, consolidate, rebuild_fts, wal_checkpoint, vacuum.

```json
{
  "project_id": "janda_workspace",
  "mode": "apply",
  "actions": ["rebuild_fts", "wal_checkpoint", "vacuum", "auto_guardrails"]
}
```

**Maintenance actions:**
| Action | Fungsi |
|--------|--------|
| `dedup` | Hapus duplikat (cosine similarity) |
| `conflict` | Deteksi memori yang saling bertentangan |
| `prune` | Hapus memori usang/berkualitas rendah (items usefulness >= 1.0 DILINDUNGI) |
| `compact` | Optimasi database |
| `loopbreak` | Deteksi dan cegah loop kesalahan |
| `clean_links` | Bersihkan links yang orphan |
| `auto_guardrails` | Generate guardrails dari pola kegagalan |
| `archive` | Arsipkan items >180 hari |
| `consolidate` | Gabungkan episodes serupa (cosine >0.85) |
| `rebuild_fts` | Rebuild FTS index — hapus ghost entries (v5.2) |
| `wal_checkpoint` | Reduce WAL file size (v5.2) |
| `vacuum` | Reclaim disk space setelah delete/deprecate |

### 8. `memory_stats`
Statistik lengkap: total items, breakdown per type/status, health check, guardrails, format compliance, database info.

```json
{
  "project_id": "janda_workspace",
  "sections": ["counts", "health", "guardrails", "audit"]
}
```

### 9. `memory_reflect`
Analisis pola kegagalan/keberhasilan (metacognition). Returns structured stats untuk LLM reasoning.

```json
{
  "project_id": "janda_workspace",
  "lookback_count": 20,
  "filter_tags": ["hacking"]
}
```

### 10. `memory_list` (NEW v5.2)
Browse/filter memory items tanpa search query. Supports pagination, tag/type filtering, sorting.

```json
{
  "project_id": "janda_workspace",
  "types": ["fact"],
  "tags": ["credential"],
  "status": "active",
  "sort_by": "usefulness_score",
  "sort_order": "desc",
  "limit": 50,
  "offset": 0,
  "title_contains": "Bappenas",
  "full_content": false
}
```

**Response includes pagination:** `{ total, limit, offset, has_more, next_offset, pages, current_page }`

---

## Memory Types

| Type | Deskripsi | Temporal Type | Score Base |
|------|-----------|---------------|-----------|
| `fact` | Fakta/informasi/credential | state | 0.5 |
| `state` | Status terkini project/target | state | 0.5 |
| `decision` | Keputusan arsitektur/teknis | rule | 0.2 |
| `runbook` | How-to/prosedur step-by-step | rule | 0.5 |
| `episode` | Log aksi teknis (Command + Outcome) | event | 0.2 |

**Score modifiers:**
- `success: true` → +0.5
- `success: false` → -0.5
- `tags: ["credential"]` → +1.5
- `verified: true` → +0.1 bonus di search
- `usefulness_score >= 1.0` → DILINDUNGI dari prune otomatis

## Status Flow

```
active → quarantined → deleted
       ↘ deprecated ↗
```

- **active**: Normal, searchable
- **quarantined**: Error >= threshold, hidden dari search (kecuali `override_quarantine: true`)
- **deprecated**: Superseded oleh item baru, score penalty 0.7×
- **deleted**: Soft-deleted, never returned

---

## Format Wajib (Writeback)

| Type | Format Required | Contoh |
|------|----------------|--------|
| episode | `Command:` + `## OUTCOME` | `Command: nmap -sV target\n## OUTCOME: Ports 80,443 open` |
| runbook | `## STEP 1` + `Command:` | `## STEP 1\nCommand: ssh root@vps` |
| fact | `## HOW TO USE` + `Command:` | `## HOW TO USE\nCommand: curl -k https://target` |
| decision | Bebas | Keputusan arsitektur |
| state | Bebas | Status terkini |

**Hard block:** Episode tanpa `Command:` + `## OUTCOME` akan ditolak.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Setup environment
cp .env.example .env
# Edit: SQLITE_PATH, EMBEDDING_MODE=hybrid, EMBEDDING_BACKEND=local

# 3. Start server
npm start
```

## MCP Configuration

```json
{
  "mcpServers": {
    "mcp-memori": {
      "command": "node",
      "args": ["/home/kali/Desktop/mcp-memori/src/server.js"],
      "env": {
        "NODE_ENV": "production",
        "SQLITE_PATH": "/home/kali/Desktop/mcp-memori/data/memory.db",
        "EMBEDDING_MODE": "hybrid",
        "EMBEDDING_BACKEND": "local",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

## Environment Variables

| Variable | Default | Deskripsi |
|----------|---------|-----------|
| `SQLITE_PATH` | `./data/memory.db` | SQLite database path |
| `EMBEDDING_MODE` | `hybrid` | `keyword_only`, `hybrid`, `vector_only` |
| `EMBEDDING_BACKEND` | `local` | `local` (sentence-transformers), `ollama`, `off` |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama endpoint (jika backend=ollama) |
| `OLLAMA_MODEL` | `nomic-embed-text` | Ollama model |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug` |
| `DEFAULT_TENANT` | `local-user` | Default tenant ID |
| `DEFAULT_PROJECT` | `antigravity` | Default project ID |

## Scripts

```bash
# Re-index semua embeddings (setelah upgrade model)
node scripts/reindex-embeddings.js

# Database backup
cp data/memory.db data/memory.db.backup.$(date +%Y%m%d)
```

## Project Structure

```
mcp-memori/
├── src/
│   ├── server.js              # MCP stdio server
│   ├── mcp/
│   │   ├── index.js           # Tool registry (10 tools)
│   │   └── tools/             # Tool implementations
│   │       ├── memory.search.js   # +offset, +full_content, +pagination
│   │       ├── memory.get.js      # +withLock concurrency
│   │       ├── memory.upsert.js   # +history backup, +fuzzy FTS
│   │       ├── memory.forget.js
│   │       ├── memory.summarize.js # +safe JSON parse
│   │       ├── memory.feedback.js  # +withLock, +DEFAULT_POLICY
│   │       ├── memory.maintain.js  # +rebuild_fts, +wal_checkpoint
│   │       ├── memory.stats.js
│   │       ├── memory.reflect.js
│   │       └── memory.list.js     # NEW v5.2: browse/filter/paginate
│   ├── retrieval/             # Search engine
│   │   └── hybridSearch.js    # Keyword + vector + recency
│   ├── governance/            # Guardrails & policy
│   ├── concurrency/           # Multi-agent safety
│   ├── db/                    # Schema & migrations
│   └── utils/
│       ├── embedding.js       # Multi-backend embedding
│       ├── embedding-local.js # @xenova/transformers (384-dim)
│       ├── cache.js           # LRU cache (200 items, 5min TTL)
│       ├── config.js          # Configuration
│       └── logger.js          # Structured logging
├── scripts/
│   └── reindex-embeddings.js  # Batch re-index utility
├── data/
│   └── memory.db              # SQLite database
└── package.json
```

## Keunggulan vs Sistem AI Memory Lain

| Feature | MCP Memory v5.0 | Mem0 | OpenAI Memory |
|---------|-----------------|------|---------------|
| **Persistence** | ✅ SQLite/PostgreSQL | ✅ Cloud | ✅ Cloud |
| **Control** | ✅ TOTAL (SQL direct) | ❌ Blackbox API | ❌ Blackbox |
| **Data Types** | ✅ 5 structured types | ⚠️ Graph | ❌ Flat text |
| **Guardrails** | ✅ ACTIVE block/warn | ❌ None | ⚠️ Safety only |
| **Self-Healing** | ✅ Auto quarantine | ❌ | ❌ |
| **Loop Breaker** | ✅ Guardrails injection | ❌ | ❌ |
| **Metacognition** | ✅ memory_reflect | ❌ | ❌ |
| **Scoring** | ✅ Custom formula | ⚠️ Proprietary | ⚠️ Recency |
| **Self-Correct** | ✅ Manual reflect + feedback | ✅ Auto-optimize | ❌ |
| **Forensic Audit** | ✅ 10,000+ entries | ⚠️ Partial | ❌ |
| **Latency** | ✅ 7-20ms (cache hit <1ms) | ⚠️ 1.4s p95 | ⚠️ Unknown |
| **Graph** | ✅ 1,315 links | ✅ Full graph | ❌ |
| **Embedding** | Local (no API key) | Requires API | Built-in |
| **Cross-Model** | Conflict detection | - | - |
| **Version History** | Auto-backup before overwrite | - | - |
| **Prune Protection** | Score-based (>= 1.0 protected) | - | - |
| **FTS Ghost Fix** | Standalone FTS5, 0 ghost | N/A | N/A |

**Keunggulan utama:** Active Guardrails via Memory — kompetitor pakai memori untuk *ingat konteks*, kita pakai memori untuk *mencegah kesalahan berulang*.

---

## Version History

| Version | Tanggal | Perubahan Utama |
|---------|---------|----------------|
| **v5.2** | **Feb 21, 2026** | **FTS standalone (0 ghost), history backup, prune protection, memory_list tool, search pagination (offset/full_content), withLock concurrency, status-aware triggers, fuzzy match FTS-based, crossModel.js removed** |
| v5.0 | Feb 8, 2026 | Score fix retroactive, enforcer functions migrated, audit compliance |
| v4.0 | Feb 7, 2026 | LRU cache, front-loading embedding, memory_reflect, archive, consolidate |
| v3.0 | Jan 2026 | Protected data, anti-summarization, full retrieval mandate |
| v2.0 | Dec 2025 | 5-layer architecture, knowledge graph, temporal intelligence |
| v1.0 | Nov 2025 | Base: search, get, upsert, forget, summarize, feedback, maintain |

## License

MIT
