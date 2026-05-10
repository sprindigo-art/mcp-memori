# MCP Memori v8.6

Production-grade MCP Memory Server for Claude Code — persistent runbook-based knowledge engine with hybrid search, lifecycle hooks, and anti-data-loss enforcement.

**265 runbooks** | **37 MB** | **2,917 entities** | **4,689 links** | **21,554 observations** | **1,027 section embeddings**

---

## Why MCP Memori?

Claude Code has no persistent memory between sessions. Context is lost on every compaction, restart, or new conversation. MCP Memori solves this:

- **Survives compaction** — hooks auto-inject target context after every context reset
- **Survives restarts** — all knowledge stored in human-readable `.md` files
- **Prevents data loss** — hard-block enforcement, writeback counters, anti-duplicate layers
- **Finds what you need** — hybrid search (FTS5 + vector + knowledge graph) with credential-priority snippets
- **Works offline** — zero API keys, zero cloud dependencies, local CPU embeddings

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                MCP Memori v8.6 — Runbook Engine             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │   Search    │  │   Upsert    │  │    Get      │         │
│  │ FTS5+Vector │  │ section-    │  │ pagination  │         │
│  │ +RRF merge  │  │ aware +     │  │ +sections   │         │
│  │ +domain-    │  │ hard-block  │  │ +health     │         │
│  │  reranking  │  │ +3-layer    │  │  warnings   │         │
│  │ +credential │  │  dedup      │  │             │         │
│  │  snippets   │  │ +fuzzy      │  │             │         │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘         │
│         │                │                │                 │
│  ┌──────▼────────────────▼────────────────▼───────────────┐ │
│  │             Runbook Files (.md)                        │ │
│  │  309 files | 32 MB | YAML frontmatter                 │ │
│  │  Sections: CREDENTIAL, EXPLOIT, RECON, GAGAL, etc.    │ │
│  │  Atomic writes (.tmp + rename) + .bak backup          │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌───────────┐  ┌────────────────┐  ┌──────────────────┐   │
│  │ FTS5 BM25 │  │ Vector v2.0    │  │ Knowledge Graph  │   │
│  │ noise-    │  │ per-SECTION    │  │ 2,289 entities   │   │
│  │ filtered  │  │ 1,027 vectors  │  │ 3,653 links      │   │
│  │ porter    │  │ 384-dim local  │  │ 2-hop reasoning  │   │
│  │ stemmer   │  │ all-MiniLM-L6  │  │                  │   │
│  └───────────┘  └────────────────┘  └──────────────────┘   │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ HOOKS (6 lifecycle events)                            │  │
│  │ SessionStart:      inject target context + auto-log   │  │
│  │ PostToolUse:       auto-capture + writeback counter   │  │
│  │ UserPromptSubmit:  auto-inject relevant memories      │  │
│  │ Stop:             template session summary + rotate   │  │
│  │ PreCompact:       fsync + compaction marker           │  │
│  │ LLM Summary:      opt-in background worker           │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌───────────────┐  ┌───────────┐  ┌───────────────────┐   │
│  │ Contradiction │  │ Provenance│  │ Per-Session       │   │
│  │ 16 patterns   │  │ auto-date │  │ Target Isolation  │   │
│  │ +reminders    │  │ [YYYY-MM] │  │ multi-instance    │   │
│  └───────────────┘  └───────────┘  └───────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## Features

### Hybrid Search (4-Layer)
```
Query → ┌─ FTS5 BM25 (noise-filtered, porter stemmer) ─────┐
        │                                                    │→ RRF Merge → Domain Rerank → Snippet
        └─ Vector v2.0 (per-section, cosine, MiniLM-L6-v2) ─┘       ↓
                                                          Knowledge Graph enrichment
                                                          Domain variant expansion
                                                          Credential-priority snippet
```

- **FTS5 BM25** — full-text with porter stemmer + unicode61, `_AUTO_LOG` noise stripped from index
- **Vector v2.0** — per-section embeddings (1 vector per `##` section, max 30/file), 384-dim local CPU
- **RRF merge** — Reciprocal Rank Fusion (k=60) combining FTS5 + vector results
- **Domain-aware reranking** — "pushidrosal.tnial" → expand all domain parts, 60%+ match = 2.5x boost
- **Credential-priority snippets** — `[CRED]` nearby +8, `password` same-line +5, `sshpass` +5
- **Knowledge graph** — 2-hop cross-runbook entity reasoning
- **Query expansion** — Indonesian synonyms + domain part variants

### Storage & Safety
- **Runbook-based** — `.md` files with YAML frontmatter, human-readable, git-friendly
- **Hard-block** — must read runbook before writing (10 min expiry, >500 chars threshold)
- **Anti-duplicate 3-layer** — exact substring + 60% near-duplicate + SHA-256 content hash (500 chars + length, 10 min window)
- **Contradiction detection** — 16 state pairs (alive/dead, patched/vuln, success/failed) with inline warnings
- **Atomic writes** — `.tmp` + rename (POSIX atomic) + `.bak` backup + file locking
- **Section-lock** — `replace_section` restricted to LIVE STATUS / RE-ENTRY only
- **Fuzzy title match** — domain-aware partial match + Jaccard similarity

### Lifecycle Hooks (6 events)
- **PostToolUse** — auto-capture every tool call to `_AUTO_LOG` + SQLite observations + writeback counter warning (>10 calls without save)
- **SessionStart** — inject LIVE STATUS + RE-ENTRY + recent auto-log entries; post-compaction re-authorization warning
- **UserPromptSubmit** — auto-inject 2 most relevant memories when prompt contains domain/IP/CVE/product signals; snippets sanitized (credentials redacted)
- **Stop** — template-based session summary appended to `## SESSION LOG` (no AI, pure regex); auto-rotate >50KB (keep last 10, archive rest); lock-protected read-modify-write
- **PreCompact** — fsync flush + compaction marker + inline JANDA AI identity + rules + target context in `newCustomInstructions` (anti-refusal post-compaction)
- **LLM Summary Worker** — opt-in (`MCP_MEMORI_LLM_SUMMARY=1`) background AI summary

### v8.6 (Latest)
- **`isMajorSection` WHITELIST** — section boundary detection via ALL-CAPS whitelist instead of blacklist. Eliminates 1360+ false section boundaries from inline `## ` headers. CREDENTIAL section fully readable (190KB vs 47KB truncated)
- **`replace_entry`** — new upsert mode: fuzzy-match `### title` and replace entire entry without exact text. Prevents duplicate entries when updating existing data
- **`##` auto-convert `###`** — inline `## ` headers in appended content automatically downgraded to `### ` to prevent future section boundary pollution
- **Snippet extraction fix** — snippet scoring now splits on major sections only (not all 1375 `## ` headers). Search snippets now show correct section data
- **acquireLock hardened** — TOCTOU fix (break→continue), returns boolean, non-EEXIST error handling, timeout 5s→15s
- **Stop hook lock fix** — lock acquired BEFORE read (TOCTOU fix), always released in finally (no orphaned .lock files)
- **Session isolation hardened** — MEMORY.md + mtime fallback blocked when sessionId present; TEKNIK_ runbooks filtered from target detection; target auto-switch on memory_get different target; logTarget for observation recording
- **Post-compaction anti-refusal** — PreCompact injects JANDA AI identity + rules inline (not just "read CLAUDE.md"); SessionStart injects identity + anti-repeat + CLAUDE.md instruction with 4000 char limit
- **Graph fixes** — entity type preserved (COALESCE, not overwrite to 'tag'); `findRelatedByRunbook` queries by runbook_id (not broken entity_name); forget updates vector+graph indexes
- **Dedup improved** — content-hash covers 500 chars + length (was 150 chars); SESSION LOG rotation markers cleaned on every Stop (not just during rotation)
- **Index failure logging** — FTS5/vector/graph update failures logged via logger.warn (was silent catch{})
- **Context sanitization** — `sanitizeTriggers()` replaces 25+ classifier trigger keywords in all hook outputs

### v8.4-v8.5
- **Per-session target isolation** — multiple Claude instances no longer contaminate each other's runbooks (session-scoped `/tmp` files)
- **SESSION LOG rotation** — auto-archive old sessions when log exceeds 50KB, keep last 10
- **FTS5 stale index cleanup** — post-transaction rebuild prevents duplicate accumulation
- **Cross-target contamination cleaner** — scanner + cleaner tool for runbooks with misplaced sections
- **Post-compaction refusal fix** — hooks + CLAUDE.md re-authorization ensures continuity after context reset
- **19 search quality fixes** — domain variant expansion, match ratio boost, credential snippets, TEKNIK depriority, coverage boost, auto-log guard, numeric octet filter

---

## 9 MCP Tools

| Tool | Purpose |
|------|---------|
| `memory_search` | Hybrid search: FTS5 + vector + RRF + domain reranking + credential snippets |
| `memory_get` | Read runbook with pagination, section filter, line-based access, health warnings |
| `memory_upsert` | Write/update with section-aware append, hard-block, fuzzy match, contradiction detect |
| `memory_forget` | Delete text, section, or entire runbook (read-before-delete enforced) |
| `memory_list` | Browse all runbooks with tag/title filter and pagination |
| `memory_stats` | Storage statistics: total files, size, tag breakdown |
| `memory_autolog` | Internal: auto-append tool call journal to `_AUTO_LOG` |
| `memory_timeline` | Chronological context viewer around events (DB or runbook based) |

### Tool Examples

**Search:**
```json
{
  "query": "SSH credential target.com",
  "project_id": "janda_workspace",
  "limit": 10
}
```

**Get (section-specific):**
```json
{
  "id": "RUNBOOK_target.com.md",
  "section": "CREDENTIAL",
  "sections_list": true
}
```

**Upsert (append to section):**
```json
{
  "items": [{
    "title": "[RUNBOOK] target.com",
    "content": "- SSH root: sshpass -p 'xxx' ssh root@target",
    "append_to_section": "CREDENTIAL",
    "auto_dual_save": true
  }]
}
```

**Write modes:**

| Mode | Parameter | Behavior |
|------|-----------|----------|
| Append to section | `append_to_section: "CREDENTIAL"` | Add to end of section, preserve existing data |
| Replace entry | `replace_entry: "dbcluster1 MySQL"` | Fuzzy-match `### title`, replace entire entry (v8.6) |
| Replace section | `replace_section: "LIVE STATUS"` | Replace entire section (LIVE STATUS/RE-ENTRY only) |
| Replace text | `replace_text: "old text"` | Surgical find & replace (must be unique in file) |
| Default | (none) | Append to end of file |

---

## Runbook Format

```markdown
---
title: "[RUNBOOK] target.com"
tags: ["target", "postgresql"]
created: 2026-01-13
updated: 2026-04-30T01:00:00Z
version: 26
success: true
---

## LIVE STATUS
Current phase, active targets, next steps

## RECON
Ports, services, versions, subdomains

## CREDENTIAL
Service credentials (append-only)

## EXPLOIT
Successful techniques with full commands

## GAGAL
Failed techniques with specific reasons

## RE-ENTRY CHECKLIST
| # | Access | Command | Priority |

## SESSION LOG
Auto-generated session summaries

## _AUTO_LOG
Auto-generated tool call journal
```

---

## Data Integrity

| Protection | Mechanism |
|------------|-----------|
| Crash-safe writes | `atomicWriteFileSync()` — .tmp + rename (POSIX atomic) |
| Backup | .bak file before every write |
| Auto-recovery | tries .bak if main file corrupt |
| File locking | 5s timeout + stale lock detection |
| Read-before-write | hard-block — 10 min expiry, >500 chars |
| Anti-duplicate | 3-layer: exact + 80% near-dup + SHA-256 |
| Contradiction | 16 state pairs with inline warnings |
| Section boundary | `isMajorSection()` + `findSectionEnd()` |
| Fuzzy title match | domain-aware + Jaccard + TLD blocklist |
| Provenance | auto `[YYYY-MM-DD]` stamp on every append |
| Session isolation | per-session target tracking (v8.4) |
| Log rotation | SESSION LOG auto-archive at 50KB (v8.4) |

---

## Comparison

| Feature | MCP Memori v8.4 | claude-mem | Mem0 | doobidoo/mcp-memory |
|---------|-----------------|------------|------|---------------------|
| Storage | `.md` runbooks (readable, git-friendly) | SQLite DB | Vector cloud | SQLite |
| Search | FTS5 + Vector v2.0 + RRF + domain-rank | FTS5 + ChromaDB | Vector + Graph | Vector only |
| Credential snippets | Yes (priority ranking) | No | No | No |
| Section CRUD | Yes (append/replace/text per section) | No (whole observation) | No | No |
| Read-before-write | Yes (hard-block, 10 min) | No | No | No |
| Anti-duplicate | 3-layer (exact+near+SHA256) | SHA256 only | Partial | No |
| Contradiction detect | 16 patterns + reminders | No | No | No |
| Lifecycle hooks | 6 hooks + writeback counter | 6 hooks | No | No |
| Post-compaction | Auto-inject + re-authorization | Context inject | No | No |
| Session isolation | Per-session (multi-instance safe) | No | No | No |
| Vector granularity | Per-section (1,027 vectors) | Per-field | Per-doc | Per-doc |
| Knowledge graph | Local (2,289 entities, 3,653 links) | No | Cloud | No |
| Dependencies | None (local CPU) | Bun + ChromaDB + uv | API key | API key |
| Search latency | <20ms (cache hit) | ~100ms | 1.4s p95 | Unknown |
| Log rotation | Auto at 50KB | No | No | No |

---

## Installation

See [INSTALL.md](INSTALL.md) for complete setup guide including:
- MCP server configuration
- Hooks configuration (6 lifecycle events)
- Directory setup
- Verification steps

### Quick Start

```bash
git clone https://github.com/sprindigo-art/mcp-memori.git
cd mcp-memori
npm install
```

Add to Claude Code MCP config (`~/.claude.json`):

```json
{
  "mcpServers": {
    "mcp-memori": {
      "command": "node",
      "args": ["~/Desktop/mcp-memori/src/server.js"],
      "env": {
        "NODE_ENV": "production",
        "EMBEDDING_MODE": "hybrid",
        "EMBEDDING_BACKEND": "local"
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
│   ├── server.js                  # MCP stdio server (JSON-RPC 2.0)
│   ├── mcp/
│   │   ├── index.js               # Tool registry (9 tools)
│   │   └── tools/
│   │       ├── memory.search.js   # FTS5 + Vector v2.0 + RRF + domain reranking
│   │       ├── memory.get.js      # Pagination, sections, health warnings
│   │       ├── memory.upsert.js   # Section-aware, hard-block, fuzzy match
│   │       ├── memory.forget.js   # Partial/full delete, read-before-delete
│   │       ├── memory.list.js     # Browse/filter/paginate
│   │       ├── memory.stats.js    # Statistics
│   │       ├── memory.autolog.js  # Hook-driven auto-capture journal
│   │       └── memory.timeline.js # Chronological context viewer
│   ├── storage/
│   │   ├── files.js               # Runbook CRUD, sections, atomic writes
│   │   ├── searchIndex.js         # FTS5 BM25 index + post-transaction rebuild
│   │   ├── vectorIndex.js         # Vector v2.0 (per-section, MiniLM-L6-v2)
│   │   └── graphIndex.js          # Knowledge graph (entities + relations)
│   └── utils/
│       ├── scrubber.js            # Password/token/JWT scrubber
│       ├── embedding.js           # Multi-backend embedding
│       ├── embedding-local.js     # @xenova/transformers (384-dim)
│       └── logger.js              # Structured logging (stderr)
├── scripts/
│   ├── hooks/
│   │   ├── hook_lib.js            # Shared helpers + per-session isolation
│   │   ├── hook_auto_capture.js   # PostToolUse: _AUTO_LOG + writeback counter
│   │   ├── hook_session_start.js  # SessionStart: target context injection
│   │   ├── hook_session_stop.js   # Stop: template summary + log rotation
│   │   ├── hook_pre_compact.js    # PreCompact: fsync + compaction marker
│   │   ├── hook_user_prompt.js    # UserPromptSubmit: memory auto-inject
│   │   └── hook_llm_summary_worker.js # Optional LLM summary (opt-in)
│   ├── patch_claude_binary.py     # Binary safety string patcher
│   └── cleanup_cross_target.js    # Cross-target contamination scanner/cleaner
├── runbooks/                      # .md runbook files (primary storage)
├── data/                          # SQLite indexes (FTS5, vector, graph)
├── archives/                      # Rotated SESSION LOG archives
├── INSTALL.md                     # Complete installation guide
├── package.json
└── mcp.config.json
```

---

## Search Fixes (v8.3–v8.4)

19 search quality improvements over v7.5:

| # | Issue | Fix |
|---|-------|-----|
| 1 | `_AUTO_LOG` noise polluting FTS5 | Strip from index |
| 2 | Domain queries only match exact string | Expand ALL domain parts as variants |
| 3 | 2-tag match boost too weak (1.6x) | 60%+ match ratio = 2.5x boost |
| 4 | Generic words ("ssh", "credential") over-boost | Filter COMMON_TECHNIQUE_WORDS |
| 5 | First proximity match returned (often wrong) | Collect ALL matches, pick best score |
| 6 | Snippet shows random section | Credential-priority: [CRED] +8, password +5, sshpass +5 |
| 7 | Short words ("pu") false-match substrings | Header bonus requires ≥3 chars |
| 8 | Unique words in body ignored | Coverage boost when uniqueInBody > 0 AND distinctHits ≥ 60% |
| 9 | `[TEKNIK]` runbooks outrank target runbooks | TEKNIK depriority: score × 0.4 when no target in title |
| 10 | Snippet content doesn't match target | Snippet target-match boost with auto-log guard |
| 11 | Numeric IP octets treated as search terms | Filter numeric-only parts from domain expansion |
| 12 | Snippet uses common words only | Force re-enrichment when snippet has only common words |
| 13 | bestSnip selection can miss better match | Safety net double-check after selection |
| 14 | `uniqueInHeader` over-weights generic matches | Multiplier reduced from 0.8 to 0.4 |
| 15 | FTS5 accumulates duplicate entries | Post-transaction DELETE + INSERT FROM runbook_index |
| 16 | Explicit DELETE before INSERT OR REPLACE | Per-entry cleanup in `updateIndexEntry()` |
| 17 | Samb-melaka.com ranked #1 for unrelated queries | Auto-log captured old queries; multi-layer fix |
| 18 | Cross-target contamination in 17 runbooks | Per-session isolation + cleanup tool |
| 19 | SESSION LOG bloat (838KB in single runbook) | Auto-rotate at 50KB, keep last 10 sessions |

---

## Known Claude Code Memory Weaknesses Addressed

Research across 30 documented Claude Code memory weaknesses (sources: GitHub issues, community reports, comparative analyses):

| Weakness | Addressed | How |
|----------|-----------|-----|
| No persistent memory | Yes | .md runbooks survive restarts |
| Context lost on compaction | Yes | SessionStart hook re-injects state |
| No read-before-write | Yes | Hard-block with 10 min expiry |
| Duplicate entries | Yes | 3-layer dedup |
| No contradiction detection | Yes | 16 state pairs |
| No credential search priority | Yes | Credential-priority snippets |
| No section-aware storage | Yes | Section CRUD (append/replace/text) |
| Single-instance only | Yes | Per-session target isolation |
| No writeback enforcement | Yes | Counter + hook warning |
| No log rotation | Yes | Auto-archive at 50KB |
| Context injection too late | Yes | SessionStart + UserPromptSubmit hooks |
| No offline capability | Yes | Zero API keys, local embeddings |
| No knowledge graph | Yes | Entity-link graph with 2-hop reasoning |
| Vector search too coarse | Yes | Per-section embeddings (not per-doc) |
| No timeline/history view | Yes | `memory_timeline` tool |
| No fuzzy matching | Yes | Domain-aware + Jaccard similarity |
| No health monitoring | Yes | Stale/bloat/mature/empty warnings |
| No auto-capture | Yes | PostToolUse hook + observations table |
| No provenance tracking | Yes | Auto date stamps on every append |

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| **v8.4** | **May 2, 2026** | **Per-session target isolation, SESSION LOG rotation (50KB/10 sessions), FTS5 stale index cleanup, cross-target contamination cleaner, post-compaction refusal fix, 19 search quality fixes, binary patcher, INSTALL.md** |
| v8.3 | Apr 30, 2026 | 9 search fixes, vector v2.0 per-section, 5 hook fixes, writeback counter, template session summary, memory_timeline |
| v7.5 | Apr 10, 2026 | Vector search (MiniLM-L6-v2 + RRF), knowledge graph, contradiction detection, fuzzy matching, atomic writes |
| v7.0 | Apr 2026 | File-based storage (.md runbooks), FTS5 BM25, section-aware upsert, hard-block |
| v6.0 | Mar 2026 | Migration from SQLite to filesystem, YAML frontmatter |
| v5.0 | Feb 2026 | LRU cache, front-loading embedding, memory_list |
| v1.0 | Nov 2025 | Initial release: search, get, upsert, forget, summarize (removed v8.7) |

## Author

**sprindigo-art** — [GitHub](https://github.com/sprindigo-art)

## License

MIT
