# MCP Memory Server v8.3

Production-grade MCP Memory Server — **OTAK UTAMA** AI berbasis runbook `.md` files.

**Status:** Production (Apr 30, 2026) | **Runbooks:** 237+ | **Size:** 14.59 MB | **Entities:** 1,750+ | **Links:** 2,698+
**Search:** FTS5 BM25 + Vector Semantic v2.0 (per-section, all-MiniLM-L6-v2) + RRF Merge + Domain-Aware Reranking
**Hooks:** 5 lifecycle hooks (auto-capture, writeback counter, post-compaction recovery, session summary)
**Benchmark:** Menang vs claude-mem plugin di 5/6 dimensi (search, get, save, compaction, storage)

---

## Arsitektur v8.3

```
┌───────────────────────────────────────────────────────────┐
│              MCP Memory v8.3 — Runbook Engine              │
├──────────┬──────────┬─────────────────────────────────────┤
│  9 Tools │ 3 Index  │ Storage: .md files + 5 Hooks        │
├──────────┴──────────┴─────────────────────────────────────┤
│                                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │   Search     │  │    Upsert    │  │     Get      │    │
│  │ FTS5+Vector  │  │ section-aware│  │  pagination  │    │
│  │ +RRF merge   │  │ +hard-block  │  │  +sections   │    │
│  │ +domain-rank │  │ +fuzzy match │  │  +warnings   │    │
│  │ +snippet-cred│  │ +3-layer dup │  │  +health     │    │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘    │
│         │                 │                  │            │
│  ┌──────▼─────────────────▼──────────────────▼──────────┐ │
│  │          Runbook Files (.md)                         │ │
│  │  237+ files | 14.59 MB | YAML frontmatter           │ │
│  │  Sections: CREDENTIAL, EXPLOIT, GAGAL, etc.         │ │
│  │  Atomic writes + .bak backup + file locking         │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                           │
│  ┌──────────┐  ┌───────────────┐  ┌────────────────┐     │
│  │ FTS5 BM25│  │ Vector v2.0   │  │ Knowledge Graph│     │
│  │ noise-   │  │ per-SECTION   │  │ entities+links │     │
│  │ filtered │  │ 384-dim local │  │ 2-hop reasoning│     │
│  └──────────┘  └───────────────┘  └────────────────┘     │
│                                                           │
│  ┌──────────────────────────────────────────────────────┐ │
│  │ HOOKS (5 lifecycle events)                           │ │
│  │ SessionStart: inject target + RE-ENTRY + auto-log   │ │
│  │ PostToolUse:  auto-capture + writeback counter       │ │
│  │ UserPromptSubmit: auto-inject 2 relevant memories   │ │
│  │ Stop:         template session summary              │ │
│  │ PreCompact:   fsync flush + compaction marker       │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                           │
│  ┌───────────────┐  ┌──────────┐  ┌──────────────┐       │
│  │ Contradiction │  │ Provenance│  │    Cache     │       │
│  │ 16 patterns   │  │ auto-date │  │  LRU 150    │       │
│  │ +reminders    │  │ [YYYY-MM] │  │  3min TTL   │       │
│  └───────────────┘  └──────────┘  └──────────────┘       │
└───────────────────────────────────────────────────────────┘
```

---

## Kemampuan Utama

### Storage & Safety
- **Runbook-based** — `.md` files, YAML frontmatter, section-aware CRUD
- **Hard-block** — WAJIB baca sebelum write (10 min expiry, >500 chars)
- **Anti-duplicate 3-layer** — exact substring + 80% near-dup + SHA-256 120s window
- **Contradiction detection** — 16 state pairs (alive/dead, patched/vuln, success/failed)
- **Atomic writes** — .tmp + rename + .bak backup + file locking
- **Section-lock** — `replace_section` hanya untuk LIVE STATUS/RE-ENTRY

### Search v8.3
- **Hybrid** — FTS5 BM25 + Vector v2.0 (per-section) + RRF merge
- **Domain-aware ranking** — "pushidrosal.tnial" → variant parts, 60%+ match ratio = 2.5x boost
- **Credential-priority snippet** — [CRED] nearby +8, password same-line +5, sshpass +5
- **_AUTO_LOG noise filter** — strip dari FTS5 index, SSH warnings strip dari hooks
- **Query expansion** — sinonim Indonesia + domain part variants
- **Knowledge graph** — entities + links + 2-hop cross-runbook reasoning

### Hooks v8.3 (5 lifecycle events)
- **PostToolUse** — auto-capture ke _AUTO_LOG + observations + writeback counter (⚠️ >10 calls)
- **SessionStart** — inject LIVE STATUS + RE-ENTRY + 10 auto-log + post-compaction warning
- **UserPromptSubmit** — auto-inject 2 memori relevan (35+ keyword signals)
- **Stop** — template session summary ke SESSION LOG
- **PreCompact** — fsync + compaction marker

### Other
- **Fuzzy title matching** — domain-aware partial + Jaccard similarity
- **Health warnings** — stale, bloat, mature, empty sections, misplaced content
- **Dual-save** — `auto_dual_save: true` untuk cross-target learning
- **LRU Cache** — 150 items, 3min TTL | **Tanpa API key** — embedding lokal

---

## 9 Tools

### 1. `memory_search`
Cari runbook dengan hybrid search (FTS5 + vector v2.0 + RRF merge + domain-aware reranking + credential-priority snippet).

```json
{
  "query": "akses SSH pushidrosal.tnial credential",
  "project_id": "janda_workspace",
  "tags": ["tnial"],
  "limit": 20
}
```

**Response:** Plaintext list — title, score, ID, 300-char snippet (credential-priority). Snippet menampilkan password/command langsung, bukan section random.

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
{ "project_id": "janda_workspace" }
```

### 8. `memory_autolog`
Internal hook tool — auto-append tool call entries ke ## _AUTO_LOG. Bypass hard-block (journal only, bukan state).

### 9. `memory_timeline`
Konteks kronologis di sekitar event. DB-based (observations) atau runbook _AUTO_LOG based.

```json
{
  "query": "curl verify_tables",
  "runbook_id": "RUNBOOK_samb-melaka.com.md",
  "depth_before": 5,
  "depth_after": 5
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

## Search Architecture v8.3

### 4-Layer Hybrid Search
```
Query → ┌─ FTS5 BM25 (noise-filtered, _AUTO_LOG stripped) ──┐
        │                                                     │→ RRF Merge → Domain Rerank → Snippet
        └─ Vector v2.0 (per-SECTION, cosine, MiniLM-L6-v2) ─┘       ↓
                                                           Knowledge Graph enrichment
                                                           Domain variant expansion
                                                           Credential-priority snippet
```

### Search Fixes v8.3 (vs v7.5)
| Fix | Masalah | Solusi |
|-----|---------|-------|
| _AUTO_LOG strip | tool call noise polusi FTS5 ranking | strip dari index |
| Domain variant | "pushidrosal.tnial" hanya match exact | expand ALL parts |
| Match ratio boost | 2 tag match = 1.6x (terlalu lemah) | 60%+ ratio = 2.5x |
| Title non-common | "ssh"+"vcenter" over-boost generik | filter COMMON words |
| Global proximity | exact domain return pertama (salah) | collect ALL, pick best |
| Credential priority | snippet random section | [CRED]/password/sshpass bonus |
| Short word skip | "pu" match "jdih**pu**" (palsu) | header bonus ≥3 chars only |

### Vector Index v2.0
- **v1.0**: 1 vector per runbook (title + 450 chars) → 0.05% coverage file besar
- **v2.0**: 1 vector per ## section (max 30/file, file >10KB) → section CREDENTIAL/EXPLOIT ter-embed
- Table: `section_embeddings` (id, section_name, embedding)
- Search: whole-doc + per-section, merge best similarity per runbook

### Scoring & Reranking v8.3
- Domain variant expansion: "pushidrosal.tnial" → [pushidrosal, tnial]
- Match ratio boost: 60%+ variants match tags/ID = 2.5x boost
- Title density: only non-COMMON words counted
- Credential snippet: proximity search with [CRED] +8, password +5, sshpass +5
- Failure penalty: 15% jika bukan query failure-specific
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
│   │   ├── index.js             # Tool registry (9 tools)
│   │   └── tools/
│   │       ├── memory.search.js     # FTS5+Vector v2.0+RRF+domain-aware reranking
│   │       ├── memory.get.js        # Pagination, sections, health warnings
│   │       ├── memory.upsert.js     # Section-aware, hard-block, fuzzy match
│   │       ├── memory.forget.js     # Partial/full delete, read-before-delete
│   │       ├── memory.list.js       # Browse/filter/paginate
│   │       ├── memory.stats.js      # Statistics
│   │       ├── memory.summarize.js  # Project summary
│   │       ├── memory.autolog.js    # Hook-driven auto-capture journal
│   │       └── memory.timeline.js   # Chronological context viewer
│   ├── storage/
│   │   ├── files.js             # Core: runbook CRUD, sections, atomic writes
│   │   ├── searchIndex.js       # FTS5 BM25 index (search_index.db)
│   │   ├── vectorIndex.js       # Vector v2.0 (per-section, MiniLM-L6-v2)
│   │   └── graphIndex.js        # Knowledge graph (entities + relations)
│   ├── retrieval/               # Legacy hybrid search (SQLite DB mode)
│   ├── governance/              # Legacy guardrails & policy
│   ├── db/                      # Legacy SQLite schema
│   └── utils/
│       ├── embedding.js         # Multi-backend embedding
│       ├── embedding-local.js   # @xenova/transformers (384-dim)
│       ├── logger.js            # Structured logging (stderr)
│       └── ...
│   │       ├── scrubber.js       # Password/token/JWT scrubber
│   │       └── ...
├── scripts/hooks/               # 5 lifecycle hooks
│   ├── hook_auto_capture.js     # PostToolUse: _AUTO_LOG + writeback counter
│   ├── hook_session_start.js    # SessionStart: target context injection
│   ├── hook_session_stop.js     # Stop: template session summary
│   ├── hook_user_prompt.js      # UserPromptSubmit: memory auto-inject
│   ├── hook_pre_compact.js      # PreCompact: fsync flush
│   └── hook_lib.js              # Shared helpers, SSH noise strip, MCP dev filter
├── runbooks/                    # 237+ .md runbook files (PRIMARY STORAGE)
├── data/
│   ├── memory.db                # Legacy SQLite (backup reference)
│   └── search_index.db          # FTS5 + vector + graph indexes
└── package.json
```

---

## Keunggulan vs Alternatif

| Feature | MCP Memory v8.3 | claude-mem | Mem0 | doobidoo/mcp-memory |
|---------|-----------------|------------|------|---------------------|
| **Storage** | .md runbooks (human-readable) | SQLite DB only | Vector cloud | SQLite |
| **Search** | FTS5 + Vector v2.0 + RRF + domain-rank | FTS5 (deprecated) + ChromaDB | Vector + Graph | Vector only |
| **Snippet** | ✅ Credential-priority, 300 chars | ❌ Compact index only | ❌ | ❌ |
| **Section CRUD** | ✅ append/replace/text per section | ❌ Whole observation | ❌ | ❌ |
| **Hard-block** | ✅ Read-before-write enforced | ❌ | ❌ | ❌ |
| **Anti-duplicate** | ✅ 3-layer (exact+near+SHA256) | ⚠️ SHA256 only | ⚠️ | ❌ |
| **Contradiction** | ✅ 16 patterns + reminders | ❌ | ❌ | ❌ |
| **Lifecycle hooks** | ✅ 5 hooks + writeback counter | ✅ 6 hooks | ❌ | ❌ |
| **Post-compaction** | ✅ Auto-inject + warning | ✅ Context inject | ❌ | ❌ |
| **Vector granularity** | ✅ Per-section (file >10KB) | ✅ Per-field | ❌ | ❌ |
| **Knowledge graph** | ✅ Local, 2-hop reasoning | ❌ | ✅ Cloud | ❌ |
| **Dependencies** | None (local CPU) | Bun + ChromaDB + uv | API key | API key |
| **Latency** | <20ms (cache hit) | ~100ms (HTTP worker) | 1.4s p95 | Unknown |

**Keunggulan utama:** Search menampilkan credential/SSH langsung di snippet, section-aware CRUD, hard-block safety, writeback counter enforcement — bukan hanya menyimpan tapi MENCEGAH kesalahan.

---

## Version History

| Version | Tanggal | Perubahan Utama |
|---------|---------|----------------|
| **v8.3** | **Apr 30, 2026** | **9 search fixes (domain variant, match ratio boost, credential-priority snippet, _AUTO_LOG noise strip, short-word header skip), vector v2.0 per-section, 5 hook fixes (writeback counter, post-compaction warning, SSH strip, MCP dev filter, UserPromptSubmit expanded), CLAUDE.md workflow v8.3, memory_timeline tool, template session summary** |
| v7.5 | Apr 10, 2026 | Vector search (MiniLM-L6-v2 + RRF), knowledge graph, contradiction detection (16 pairs), fuzzy domain matching, atomic writes + file locking, auto-provenance, health warnings, dual-save |
| v7.0 | Apr 2026 | File-based storage (.md runbooks), FTS5 BM25, section-aware upsert, hard-block, LRU cache, query expansion |
| v6.0 | Mar 2026 | Migration from SQLite to filesystem, YAML frontmatter |
| v5.0 | Feb 2026 | LRU cache, front-loading embedding, memory_list |
| v1.0 | Nov 2025 | Base: search, get, upsert, forget, summarize |

## License

MIT
