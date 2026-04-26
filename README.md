# MCP Memory Server v7.5

Production-grade MCP Memory Server — **OTAK UTAMA** AI berbasis runbook `.md` files.

**Status:** Production (Apr 10, 2026) | **Runbooks:** 210 | **Size:** 10.45 MB | **Entities:** 1,750 | **Links:** 2,698
**Search:** FTS5 BM25 + Vector Semantic (all-MiniLM-L6-v2) + RRF Merge | **Graph:** Knowledge graph cross-runbook

---

## Arsitektur v7.5

```
┌──────────────────────────────────────────────────────┐
│              MCP Memory v7.5 — Runbook Engine         │
├──────────┬──────────┬────────────────────────────────┤
│  7 Tools │ 3 Index  │ Storage: .md files             │
├──────────┴──────────┴────────────────────────────────┤
│                                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │   Search    │  │    Upsert    │  │     Get     │ │
│  │ FTS5+Vector │  │ section-aware│  │  pagination │ │
│  │ +RRF merge  │  │ +hard-block  │  │  +warnings  │ │
│  │ +rerank     │  │ +fuzzy match │  │  +sections  │ │
│  └──────┬──────┘  └──────┬───────┘  └──────┬──────┘ │
│         │                │                 │        │
│  ┌──────▼────────────────▼─────────────────▼──────┐ │
│  │          Runbook Files (.md)                    │ │
│  │  210 files | 10.45 MB | YAML frontmatter       │ │
│  │  Sections: CREDENTIAL, EXPLOIT, GAGAL, etc.    │ │
│  │  Atomic writes + .bak backup + file locking    │ │
│  └────────────────────────────────────────────────┘ │
│                                                      │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────┐ │
│  │ FTS5 BM25│  │ Vector Index │  │ Knowledge Graph│ │
│  │ search   │  │ MiniLM-L6-v2 │  │ 1,750 entities │ │
│  │ _index.db│  │ 384-dim local│  │ 2,698 links    │ │
│  └──────────┘  └──────────────┘  └────────────────┘ │
│                                                      │
│  ┌───────────────┐  ┌──────────┐  ┌──────────────┐  │
│  │ Contradiction │  │ Provenance│  │    Cache     │  │
│  │ 18 patterns   │  │ auto-date │  │  LRU 150    │  │
│  │ +warnings     │  │ [YYYY-MM] │  │  3min TTL   │  │
│  └───────────────┘  └──────────┘  └──────────────┘  │
└──────────────────────────────────────────────────────┘
```

---

## Kemampuan Utama

- **Runbook-based storage** — `.md` files dengan YAML frontmatter, section-aware operations
- **Hybrid search** — FTS5 BM25 + vector semantic (all-MiniLM-L6-v2, 384-dim) + Reciprocal Rank Fusion
- **Knowledge graph** — 1,750 entities (targets, services, CVEs, techniques) + 2,698 cross-runbook links
- **Hard-block read-before-write** — WAJIB baca runbook sebelum boleh upsert (10 menit expiry)
- **Section-aware ops** — `append_to_section`, `replace_section`, `replace_text` dengan boundary detection
- **Anti-duplicate** — content dedup pada append, skips identical entries
- **Contradiction detection** — 18 pattern pairs (alive/dead, patched/vulnerable, success/failed, dll)
- **Fuzzy title matching** — domain-aware: `[RUNBOOK] unitomo` → match `unitomo.ac.id`, prevents duplicate files
- **Atomic writes** — write to .tmp, rename (POSIX atomic) + .bak backup + file locking
- **Auto-provenance** — setiap append otomatis di-stamp `[YYYY-MM-DD]`
- **Health warnings** — stale (>30 hari), bloat (>200KB), mature (v>50), empty sections
- **Dual-save** — `auto_dual_save: true` untuk auto-save ke kesalahan/teknik universal
- **Post-write verify** — `verified_total_chars` di response setelah write
- **Misplaced content warning** — warn jika content menyebut target berbeda dari runbook title
- **LRU Cache** — response cepat untuk runbooks yang sering diakses (150 items, 3min TTL)
- **Tanpa API key** — embedding lokal via @xenova/transformers

---

## 7 Tools

### 1. `memory_search`
Cari runbook dengan hybrid search (FTS5 + vector + RRF merge + reranking + target-tag boost).

```json
{
  "query": "postgresql credential exploit",
  "project_id": "janda_workspace",
  "tags": ["unitomo"],
  "required_tags": ["credential"],
  "limit": 20,
  "offset": 0,
  "full_content": false,
  "scope_id": "RUNBOOK_unitomo.ac.id.md"
}
```

**Response:** `results[]` dengan score, snippet, tags, related_entities | `meta.vector_used`, `meta.vector_results`

### 2. `memory_get`
Baca isi runbook lengkap. Support pagination, section filter, line-based read.

```json
{
  "id": "RUNBOOK_unitomo.ac.id.md",
  "section": "CREDENTIAL",
  "sections_list": true,
  "line": 100,
  "line_count": 50,
  "offset": 0,
  "limit": 80000
}
```

**Modes:**
- `sections_list: true` — navigasi semua sections + health analysis
- `section: "CREDENTIAL"` — baca section spesifik
- `line: 100, line_count: 50` — baca per line (untuk runbook besar)
- Default — full content dengan pagination

**Warnings:** `⚠️ STALE` (>30 hari) | `⚠️ BLOAT` (>200KB) | `ℹ️ MATURE` (v>50)

### 3. `memory_upsert`
Simpan/update runbook. Append-only: content lama TIDAK dihapus. **WAJIB memory_get dulu.**

```json
{
  "items": [{
    "title": "[RUNBOOK] target.com",
    "content": "- SSH root berhasil\n- Command: sshpass -p 'xxx' ssh root@target",
    "tags": ["target", "credential"],
    "append_to_section": "CREDENTIAL",
    "replace_section": "LIVE STATUS",
    "replace_text": "old text here",
    "auto_dual_save": true,
    "success": true,
    "verified": true,
    "confidence": 0.95
  }]
}
```

**Write modes:**
| Mode | Parameter | Behavior |
|------|-----------|----------|
| Append to section | `append_to_section: "CREDENTIAL"` | Tambah di AKHIR section, preserve semua data lama |
| Replace section | `replace_section: "LIVE STATUS"` | Ganti SELURUH section (hanya untuk LIVE STATUS/RE-ENTRY) |
| Replace text | `replace_text: "old text"` | Edit surgical — cari & ganti teks spesifik |
| Default append | (tanpa parameter) | Append ke akhir file |

**Safety features:**
- Hard-block: tolak upsert jika runbook belum dibaca (`hasBeenRead()`)
- Anti-duplicate: skip jika content sudah ada di section
- Fuzzy match: `[RUNBOOK] unitomo` → auto-match ke `unitomo.ac.id.md`
- Contradiction detection: warn jika data baru konflik data lama (18 patterns)
- Auto-provenance: stamp `[YYYY-MM-DD]` pada setiap append
- Post-write verify: `verified_total_chars` di response
- Dual-save suggestion: remind jika content punya success/failure tapi auto_dual_save off
- Misplaced warning: warn jika content sebut target berbeda

**Reminders di response:**
- `⚠️ CONTRADICTION` — data baru konflik data lama
- `⚠️ MISPLACED?` — content mungkin di runbook yang salah
- `💡 DUAL-SAVE` — suggest auto_dual_save untuk cross-target learning
- `⚠️ CREDENTIAL DEAD` — credential terdeteksi tidak valid
- `⚠️ FAILURE DETECTED` — content mengandung indikasi kegagalan

### 4. `memory_forget`
Hapus teks/section/file dari runbook. **WAJIB memory_get dulu.**

```json
{
  "id": "RUNBOOK_target.com.md",
  "reason": "Data sudah outdated",
  "remove_text": "exact text to remove",
  "remove_section": "SECTION NAME"
}
```

### 5. `memory_list`
Browse semua runbook files dengan filter dan pagination.

```json
{
  "project_id": "janda_workspace",
  "tags": ["postgresql"],
  "title_contains": "unitomo",
  "limit": 20,
  "offset": 0
}
```

### 6. `memory_stats`
Statistik runbook: total, size, tags breakdown.

```json
{
  "project_id": "janda_workspace"
}
```

### 7. `memory_summarize`
Ringkasan project dari runbook files.

```json
{
  "project_id": "janda_workspace"
}
```

---

## Runbook Format

```markdown
---
title: "[RUNBOOK] target.com"
tags: ["target", "geoserver", "postgresql"]
created: 2026-01-13
updated: 2026-04-10T01:00:00Z
version: 26
success: true
verified: true
confidence: 0.95
---

## LIVE STATUS
| # | Access | Status | Last Checked |

## RECON
- Port, service, version

## EXPLOIT
- CVE/teknik, command, hasil

## CREDENTIAL (APPEND-ONLY)
- Service, user, pass/key, command lengkap

## PERSISTENCE
- Path, fungsi, cara akses, cara hapus

## ROOT / PRIVESC
- Teknik, command, bukti

## RE-ENTRY CHECKLIST
| # | Access | Command | Priority |

## GAGAL
- Teknik, alasan SPESIFIK, tanggal

## CLEANUP
- File yang harus dihapus
```

---

## Search Architecture

### 3-Layer Hybrid Search
```
Query → ┌─ FTS5 BM25 (keyword match, porter stemming) ─┐
        │                                                │→ RRF Merge → Rerank → Results
        └─ Vector Similarity (cosine, MiniLM-L6-v2) ────┘
                                                    ↓
                                          Knowledge Graph enrichment
                                          (related_entities per result)
```

### Knowledge Graph
- **Entity types:** target, service, cve, technique, tag
- **Relations:** targets, uses_service, exploits_cve, uses_technique, tagged
- **Queries:** `queryGraph("postgresql")` → semua runbook yang pakai PostgreSQL
- **2-hop:** `findRelatedEntities("unitomo")` → entities yang co-occur dengan unitomo

### Scoring & Reranking
- BM25 score normalization (dynamic max, bukan hardcoded)
- Target-tag boost (20% per matching keyword, cap 50%)
- Title target boost (15% per match)
- Failure penalty (15% jika bukan query failure-specific)
- RRF merge constant k=60

---

## Data Integrity

| Protection | Mechanism |
|------------|-----------|
| **Crash-safe writes** | `atomicWriteFileSync()` — .tmp + rename (POSIX atomic) |
| **Backup** | .bak file created before every write |
| **Auto-recovery** | `readRunbook()` tries .bak if main file corrupt |
| **File locking** | `acquireLock/releaseLock` with 5s timeout + stale lock detection |
| **Read-before-write** | `hasBeenRead()` hard-block — 10 min expiry, needs >500 chars read |
| **Anti-duplicate** | Content dedup in `appendToSection()` |
| **Contradiction detection** | 18 pattern pairs with inline warnings |
| **Section boundary** | `isMajorSection()` + `findSectionEnd()` — sub-headings don't terminate |
| **Fuzzy title match** | Domain-aware partial match + Jaccard similarity + generic TLD blocklist |
| **Provenance** | Auto `[YYYY-MM-DD]` stamp on append |

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start server
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
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

---

## Project Structure

```
mcp-memori/
├── src/
│   ├── server.js                # MCP stdio server (JSON-RPC 2.0)
│   ├── mcp/
│   │   ├── index.js             # Tool registry (7 tools)
│   │   └── tools/
│   │       ├── memory.search.js     # FTS5+Vector+RRF hybrid search
│   │       ├── memory.get.js        # Pagination, sections, health warnings
│   │       ├── memory.upsert.js     # Section-aware, hard-block, fuzzy match
│   │       ├── memory.forget.js     # Partial/full delete, read-before-delete
│   │       ├── memory.list.js       # Browse/filter/paginate
│   │       ├── memory.stats.js      # Statistics
│   │       └── memory.summarize.js  # Project summary
│   ├── storage/
│   │   ├── files.js             # Core: runbook CRUD, sections, atomic writes
│   │   ├── searchIndex.js       # FTS5 BM25 index (search_index.db)
│   │   ├── vectorIndex.js       # Vector embeddings (MiniLM-L6-v2)
│   │   └── graphIndex.js        # Knowledge graph (entities + relations)
│   ├── retrieval/               # Legacy hybrid search (SQLite DB mode)
│   ├── governance/              # Legacy guardrails & policy
│   ├── db/                      # Legacy SQLite schema
│   └── utils/
│       ├── embedding.js         # Multi-backend embedding
│       ├── embedding-local.js   # @xenova/transformers (384-dim)
│       ├── logger.js            # Structured logging (stderr)
│       └── ...
├── runbooks/                    # 210 .md runbook files (PRIMARY STORAGE)
├── data/
│   ├── memory.db                # Legacy SQLite (backup reference)
│   └── search_index.db          # FTS5 + vector + graph indexes
└── package.json
```

---

## Keunggulan vs MCP Memory Publik

| Feature | MCP Memory v7.5 | Mem0 | OpenAI Memory | doobidoo/mcp-memory |
|---------|-----------------|------|---------------|---------------------|
| **Storage** | .md runbooks (human-readable) | Vector + Graph cloud | Blackbox | SQLite |
| **Search** | FTS5 + Vector + RRF + rerank | Vector + Graph | Unknown | Vector only |
| **Section-aware** | ✅ append/replace per section | ❌ Flat entries | ❌ | ❌ |
| **Read-before-write** | ✅ Hard-block enforced | ❌ | ❌ | ❌ |
| **Contradiction detection** | ✅ 18 patterns inline | ❌ Manual | ❌ | ❌ |
| **Anti-duplicate** | ✅ Content dedup on append | ⚠️ Entity resolution | ❌ | ❌ |
| **Fuzzy match** | ✅ Domain-aware + Jaccard | ⚠️ Entity matching | ❌ | ❌ |
| **Atomic writes** | ✅ .tmp + rename + .bak + lock | ❌ | N/A | ❌ |
| **Provenance** | ✅ Auto date stamp | ⚠️ Timestamp only | ❌ | ❌ |
| **Health warnings** | ✅ Stale/bloat/mature/misplaced | ❌ | ❌ | ❌ |
| **Knowledge graph** | ✅ 1,750 entities local | ✅ Cloud graph | ❌ | ❌ |
| **Post-write verify** | ✅ verified_total_chars | ❌ | ❌ | ❌ |
| **Dual-save** | ✅ auto_dual_save opt-in | ❌ | ❌ | ❌ |
| **Embedding** | Local (no API key) | Requires API | Built-in | Requires API |
| **Latency** | <20ms (cache hit) | 1.4s p95 | Unknown | Unknown |

**Keunggulan utama:** Section-aware runbook memory yang MENCEGAH kesalahan (hard-block, contradiction, misplaced, anti-duplicate) — bukan hanya menyimpan.

---

## Version History

| Version | Tanggal | Perubahan Utama |
|---------|---------|----------------|
| **v7.5** | **Apr 10, 2026** | **Vector search (MiniLM-L6-v2 + RRF), knowledge graph (1,750 entities), contradiction detection (18 pairs), fuzzy domain matching, atomic writes + file locking, auto-provenance stamp, stale/bloat/mature warnings, section health, misplaced content warning, dual-save suggestion, post-write verify, anti-regression** |
| v7.0 | Apr 2026 | File-based storage (.md runbooks), FTS5 BM25 search index, section-aware upsert (append_to_section/replace_section), hard-block read-before-write, LRU cache, query expansion |
| v6.0 | Mar 2026 | Migration from SQLite to filesystem, YAML frontmatter, section parsing |
| v5.2 | Feb 21, 2026 | FTS standalone, history backup, prune protection, memory_list |
| v5.0 | Feb 8, 2026 | LRU cache, memory_reflect, front-loading embedding |
| v4.0 | Feb 7, 2026 | Archive, consolidate, temporal intelligence |
| v2.0 | Dec 2025 | 5-layer architecture, knowledge graph, temporal decay |
| v1.0 | Nov 2025 | Base: search, get, upsert, forget, summarize |

## License

MIT
