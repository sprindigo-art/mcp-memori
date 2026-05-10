# MCP Memori v8.7

Production-grade MCP Memory Server for Claude Code — persistent runbook-based knowledge engine with hybrid search, lifecycle hooks, and anti-data-loss enforcement.

**269 runbooks** | **35 MB** | **3,059 entities** | **4,926 links** | **23,423 observations** | **1,522 section embeddings**

---

## Why MCP Memori?

Claude Code has no persistent memory between sessions. Context is lost on every compaction, restart, or new conversation. MCP Memori solves this:

- **Survives compaction** — hooks auto-inject target context after every context reset
- **Survives restarts** — all knowledge stored in human-readable `.md` files
- **Prevents data loss** — hard-block enforcement, writeback counters, anti-duplicate layers
- **Finds what you need** — hybrid search (FTS5 + vector + knowledge graph) with credential-priority snippets
- **Pre-write verification** — duplicate, contradiction, and staleness checks before saving
- **Works offline** — zero API keys, zero cloud dependencies, local CPU embeddings

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                MCP Memori v8.7 — Runbook Engine             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │   Search    │  │   Upsert    │  │    Get      │         │
│  │ FTS5+Vector │  │ section-    │  │ pagination  │         │
│  │ +RRF merge  │  │ aware +     │  │ +sections   │         │
│  │ +domain-    │  │ hard-block  │  │ +search     │         │
│  │  reranking  │  │ +3-layer    │  │ +health     │         │
│  │ +credential │  │  dedup      │  │  warnings   │         │
│  │  snippets   │  │ +fuzzy      │  │             │         │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘         │
│         │                │                │                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │   Verify    │  │   Forget    │  │  Timeline   │         │
│  │ read-only   │  │ dry_run +   │  │ chronolog.  │         │
│  │ duplicate + │  │ occurrence  │  │ context     │         │
│  │ contradict  │  │ guard +     │  │ viewer      │         │
│  │ + staleness │  │ hard-block  │  │             │         │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘         │
│         │                │                │                 │
│  ┌──────▼────────────────▼────────────────▼───────────────┐ │
│  │             Runbook Files (.md)                        │ │
│  │  269 files | 35 MB | YAML frontmatter                 │ │
│  │  Sections: CREDENTIAL, EXPLOIT, RECON, GAGAL, etc.    │ │
│  │  Atomic writes (.tmp + rename) + .bak backup          │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌───────────┐  ┌────────────────┐  ┌──────────────────┐   │
│  │ FTS5 BM25 │  │ Vector v2.0    │  │ Knowledge Graph  │   │
│  │ noise-    │  │ per-SECTION    │  │ 3,059 entities   │   │
│  │ filtered  │  │ 1,522 vectors  │  │ 4,926 links      │   │
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
│  │ PreCompact:       identity + rules + target context   │  │
│  │ LLM Summary:      opt-in background worker           │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌───────────────┐  ┌───────────┐  ┌───────────────────┐   │
│  │ Contradiction │  │ Provenance│  │ Per-Session       │   │
│  │ 26 pairs      │  │ auto-date │  │ Target Isolation  │   │
│  │ bidirectional │  │ [YYYY-MM] │  │ multi-instance    │   │
│  │ EN+ID         │  │           │  │                   │   │
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
- **Structured output** — each result includes `id`, `title`, `score`, `snippet`, `next_call`

### Storage & Safety
- **Runbook-based** — `.md` files with YAML frontmatter, human-readable, git-friendly
- **Hard-block** — must read runbook before writing (10 min expiry, >500 chars threshold)
- **Anti-duplicate 3-layer** — exact substring + 60% near-duplicate + SHA-256 content hash (500 chars + length, 10 min window)
- **Contradiction detection** — 26 state pairs bidirectional (EN+ID: alive/dead, success/failed, berhasil/gagal, etc.) with inline warnings
- **Pre-write verification** — `memory_verify` tool checks duplicate, contradiction, staleness before write (read-only)
- **Atomic writes** — `.tmp` + rename (POSIX atomic) + `.bak` backup + O_EXCL file locking
- **Section-lock** — `replace_section` restricted to LIVE STATUS / RE-ENTRY only
- **Fuzzy title match** — domain-aware partial match + Jaccard similarity
- **Replace entry** — fuzzy-match `### title` with ambiguity guard (gap < 15 = blocked, prevents wrong overwrite)

### Lifecycle Hooks (6 events)
- **PostToolUse** — auto-capture every tool call to `_AUTO_LOG` + SQLite observations + writeback counter warning (>10 calls without save) + per-session target tracking
- **SessionStart** — inject LIVE STATUS + RE-ENTRY + recent auto-log entries; post-compaction re-authorization with identity + rules inline
- **UserPromptSubmit** — auto-inject 2 most relevant memories when prompt contains domain/IP/CVE/product signals; snippets sanitized (credentials redacted); file extensions and code identifiers excluded from false triggers
- **Stop** — template-based session summary appended to `## SESSION LOG`; auto-rotate >50KB (keep last 10, archive rest); lock-protected atomic write
- **PreCompact** — fsync flush + compaction marker + JANDA AI identity + rules + LIVE STATUS/RE-ENTRY + safe credential pointer in `newCustomInstructions` (raw credentials NOT injected)
- **LLM Summary Worker** — opt-in (`MCP_MEMORI_LLM_SUMMARY=1`) background AI summary

### v8.7 (Latest)
- **`memory_verify`** — read-only pre-write check: duplicate, near-duplicate, contradiction, staleness detection. Deterministic target resolution (RUNBOOK preferred over TEKNIK). Returns `target_resolution.method` for transparency
- **`memory_type` routing** — 11 intent types (credential, exploit_success, exploit_failure, status, recon, todo, blocker, command, lesson, decision, environment) auto-route to correct section + write mode
- **`memory_summarize` removed** — redundant with memory_stats + memory_list. Tools 10 → 9
- **Contradiction pairs expanded** — 16 → 26 bidirectional pairs including cross-language EN↔ID (failed/berhasil, success/gagal)
- **Replace entry ambiguity guard** — mid-line `###` detection via lookbehind regex; double header prevention when content starts with `###`; gap < 15 between top candidates = blocked
- **Verify target resolution** — deterministic priority: exact filename → title-to-filename → substring (RUNBOOK first) → search fallback (RUNBOOK preferred)
- **P0 safety fixes** — `findSectionEndForDelete` stops at ANY heading; occurrence guard for remove_text; scrubber +4 patterns; RETRIEVED MEMORY delimiters on all hooks; safe credential pointer in PreCompact
- **P1 ergonomics** — cross-target read-only (memory_get doesn't switch target); memory_forget dry_run preview; UserPromptSubmit regex excludes .js/.py/.md and code identifiers; atomicWriteFileSync in Stop hook
- **Structured search output** — `_raw` with id/title/score/snippet/next_call per result; server passes structuredContent
- **Dead parameters cleaned** — project_id not required; types/override_quarantine/allow_relations/full_content removed from schemas
- **128 unit tests** — P0 (24) + P1-A (24) + P1-B (17) + P2-A (36) + E2E bugfix (27)

### v8.5–v8.6
- **Per-session target isolation** — multiple Claude instances no longer contaminate each other's runbooks (session-scoped `/tmp` files)
- **SESSION LOG rotation** — auto-archive old sessions when log exceeds 50KB, keep last 10
- **FTS5 stale index cleanup** — post-transaction rebuild prevents duplicate accumulation
- **`isMajorSection` WHITELIST** — section boundary via ALL-CAPS whitelist. Eliminates 1360+ false boundaries
- **`replace_entry`** — fuzzy-match `### title` and replace entire entry without exact text
- **acquireLock hardened** — TOCTOU fix, returns boolean, O_EXCL atomic, 15s timeout
- **Post-compaction anti-refusal** — PreCompact injects identity + rules inline
- **Dedup improved** — content-hash 500 chars + length (was 150); near-dup 60% (was 80%)
- **memory_get `search` param** — filter `###` entries within a section by keyword
- **Context sanitization** — `sanitizeTriggers()` replaces 25+ classifier trigger keywords
- **19 search quality fixes** — domain variant expansion, credential snippets, TEKNIK depriority, coverage boost

### v8.3–v8.4
- **19 search quality fixes** — domain variants, match ratio boost, credential snippets, coverage boost, auto-log guard
- **Vector v2.0** — per-section embeddings (not per-doc), 384-dim local MiniLM-L6-v2
- **5 hook fixes** — SSH warning strip, MCP dev filter, writeback counter, post-compact warning, expanded signals
- **Cross-target contamination cleaner** — scanner + cleaner tool for runbooks with misplaced sections
- **Post-compaction refusal fix** — hooks + CLAUDE.md re-authorization

---

## 9 MCP Tools

| Tool | Purpose |
|------|---------|
| `memory_search` | Hybrid search: FTS5 + vector + RRF + domain reranking + credential snippets. Returns structured results with `next_call` |
| `memory_get` | Read runbook with pagination, section filter, `search` param for entry lookup, health warnings. Unlocks hard-block |
| `memory_upsert` | Write/update with section-aware append, hard-block, fuzzy match, contradiction detect, `memory_type` auto-routing, `replace_entry` with ambiguity guard |
| `memory_forget` | Delete text/section/file with read-before-delete enforcement, `dry_run` preview, occurrence guard |
| `memory_verify` | Read-only pre-write check: duplicate, near-duplicate, contradiction, staleness. Deterministic RUNBOOK-first target resolution |
| `memory_stats` | Storage statistics: total files, size, tag breakdown, verified/success/fail counts |
| `memory_list` | Browse all runbooks with tag/title filter and pagination |
| `memory_autolog` | Internal: auto-append tool call journal to `_AUTO_LOG` |
| `memory_timeline` | Chronological context viewer around events (SQLite observations or runbook based) |

### Tool Examples

**Search:**
```json
{
  "query": "SSH credential target.com",
  "limit": 10
}
```

**Get (section with entry search):**
```json
{
  "id": "RUNBOOK_target.com.md",
  "section": "CREDENTIAL",
  "search": "10.1.178.5"
}
```

**Upsert (with memory_type auto-routing):**
```json
{
  "items": [{
    "title": "[RUNBOOK] target.com",
    "content": "- SSH root: sshpass -p 'xxx' ssh root@target",
    "memory_type": "credential"
  }]
}
```

**Upsert (explicit section):**
```json
{
  "items": [{
    "title": "[RUNBOOK] target.com",
    "content": "CVE-2024-1234 failed: port 8080 not open",
    "append_to_section": "GAGAL",
    "auto_dual_save": true
  }]
}
```

**Verify (pre-write check):**
```json
{
  "claim": "SSH root access to 10.20.30.40",
  "target": "target.com",
  "check": "all"
}
```

**Forget (dry run preview):**
```json
{
  "id": "RUNBOOK_target.com.md",
  "remove_text": "old credential entry",
  "reason": "outdated credential",
  "dry_run": true
}
```

**Write modes:**

| Mode | Parameter | Behavior |
|------|-----------|----------|
| Auto-route | `memory_type: "credential"` | Route to correct section based on intent (11 types) |
| Append to section | `append_to_section: "CREDENTIAL"` | Add to end of section, preserve existing data |
| Replace entry | `replace_entry: "MySQL Root"` | Fuzzy-match `### title`, replace entire entry. Ambiguity guard blocks when gap < 15 |
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
updated: 2026-05-10T11:00:00Z
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
| File locking | O_EXCL atomic + 15s timeout + re-entrant depth |
| Read-before-write | hard-block — 10 min expiry, >500 chars |
| Anti-duplicate | 3-layer: exact + 60% near-dup + SHA-256 (500 chars + length) |
| Contradiction | 26 state pairs bidirectional (EN+ID) with inline warnings |
| Pre-write verify | `memory_verify` read-only check (duplicate + contradiction + staleness) |
| Section boundary | `isMajorSection()` WHITELIST + `findSectionEnd()` |
| Replace entry guard | Ambiguity blocked when gap < 15 between top candidates |
| Fuzzy title match | domain-aware + Jaccard + TLD blocklist |
| Provenance | auto `[YYYY-MM-DD]` stamp on every append |
| Session isolation | per-session target tracking via `/tmp` (multi-instance safe) |
| Log rotation | SESSION LOG auto-archive at 50KB, keep last 10 |
| Credential safety | scrubber (14 patterns), PreCompact safe pointer (no raw inject) |
| Dry run | `memory_forget` preview before destructive delete |

---

## Comparison

| Feature | MCP Memori v8.7 | claude-mem | Mem0 | doobidoo/mcp-memory |
|---------|-----------------|------------|------|---------------------|
| Storage | `.md` runbooks (readable, git-friendly) | SQLite DB | Vector cloud | SQLite |
| Search | FTS5 + Vector v2.0 + RRF + domain-rank | FTS5 + ChromaDB | Vector + Graph | Vector only |
| Credential snippets | Yes (priority ranking) | No | No | No |
| Section CRUD | Yes (append/replace/text/entry per section) | No (whole observation) | No | No |
| Read-before-write | Yes (hard-block, 10 min) | No | No | No |
| Pre-write verify | Yes (memory_verify: dup+contradiction+stale) | No | No | No |
| Anti-duplicate | 3-layer (exact+near-60%+SHA256) | SHA256 only | Partial | No |
| Contradiction detect | 26 pairs bidirectional EN+ID | No | No | No |
| Lifecycle hooks | 6 hooks + writeback counter | 6 hooks | No | No |
| Post-compaction | Auto-inject + identity + re-authorization | Context inject | No | No |
| Session isolation | Per-session (multi-instance safe) | No | No | No |
| Vector granularity | Per-section (1,522 vectors) | Per-field | Per-doc | Per-doc |
| Knowledge graph | Local (3,059 entities, 4,926 links) | No | Cloud | No |
| Memory type routing | 11 intent types → auto section | No | No | No |
| Replace entry guard | Ambiguity detection (gap < 15) | No | No | No |
| Dry run delete | Yes (preview before commit) | No | No | No |
| Dependencies | None (local CPU) | Bun + ChromaDB + uv | API key | API key |
| Log rotation | Auto at 50KB | No | No | No |
| Unit tests | 128 (21 suites) | Unknown | Unknown | Unknown |

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
│   │       ├── memory.get.js      # Pagination, sections, search, health warnings
│   │       ├── memory.upsert.js   # Section-aware, hard-block, fuzzy match, ambiguity guard
│   │       ├── memory.forget.js   # Partial/full delete, dry_run, occurrence guard
│   │       ├── memory.verify.js   # Read-only pre-write check (dup/contradiction/stale)
│   │       ├── memory.list.js     # Browse/filter/paginate
│   │       ├── memory.stats.js    # Statistics
│   │       ├── memory.autolog.js  # Hook-driven auto-capture journal
│   │       └── memory.timeline.js # Chronological context viewer
│   ├── storage/
│   │   ├── files.js               # Runbook CRUD, sections, atomic writes, O_EXCL lock
│   │   ├── searchIndex.js         # FTS5 BM25 index + post-transaction rebuild
│   │   ├── vectorIndex.js         # Vector v2.0 (per-section, MiniLM-L6-v2)
│   │   └── graphIndex.js          # Knowledge graph (entities + relations)
│   └── utils/
│       ├── scrubber.js            # Password/token/JWT/SSH key scrubber (14 patterns)
│       ├── memoryTypeRouter.js    # Intent → section routing (11 types)
│       ├── embedding.js           # Multi-backend embedding
│       ├── embedding-local.js     # @xenova/transformers (384-dim)
│       └── logger.js              # Structured logging (stderr)
├── scripts/
│   ├── hooks/
│   │   ├── hook_lib.js            # Shared helpers + per-session isolation
│   │   ├── hook_auto_capture.js   # PostToolUse: _AUTO_LOG + writeback counter
│   │   ├── hook_session_start.js  # SessionStart: target context injection
│   │   ├── hook_session_stop.js   # Stop: template summary + log rotation
│   │   ├── hook_pre_compact.js    # PreCompact: identity + rules + safe credential pointer
│   │   ├── hook_user_prompt.js    # UserPromptSubmit: memory auto-inject
│   │   └── hook_llm_summary_worker.js # Optional LLM summary (opt-in)
│   └── cleanup_cross_target.js    # Cross-target contamination scanner/cleaner
├── test/
│   ├── p0-fixes.test.js           # P0 safety tests (24)
│   ├── p1a-fixes.test.js          # P1-A isolation tests (24)
│   ├── p1b-fixes.test.js          # P1-B structured output tests (17)
│   ├── p2a-fixes.test.js          # P2-A verify + routing tests (36)
│   └── e2e-bugfix.test.js         # E2E bugfix regression tests (27)
├── runbooks/                      # .md runbook files (primary storage)
├── data/                          # SQLite indexes (FTS5, vector, graph, observations)
├── archives/                      # Rotated SESSION LOG archives
├── INSTALL.md                     # Complete installation guide
├── package.json
└── mcp.config.json
```

---

## Known Claude Code Memory Weaknesses Addressed

| Weakness | Addressed | How |
|----------|-----------|-----|
| No persistent memory | Yes | .md runbooks survive restarts |
| Context lost on compaction | Yes | SessionStart + PreCompact hooks re-inject state |
| No read-before-write | Yes | Hard-block with 10 min expiry |
| Duplicate entries | Yes | 3-layer dedup (exact + near-60% + SHA256) |
| No contradiction detection | Yes | 26 state pairs bidirectional (EN+ID) |
| No pre-write verification | Yes | `memory_verify` read-only check |
| No credential search priority | Yes | Credential-priority snippets |
| No section-aware storage | Yes | Section CRUD (append/replace/text/entry) |
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
| No intent-based routing | Yes | `memory_type` auto-routes to correct section |
| No delete preview | Yes | `memory_forget` dry_run mode |
| Wrong entry overwrite | Yes | `replace_entry` ambiguity guard (gap < 15) |

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| **v8.7** | **May 10, 2026** | **memory_verify tool, memory_type routing (11 types), contradiction 16→26 pairs, replace_entry ambiguity guard + mid-line detection, verify target resolution (RUNBOOK-first), memory_summarize removed (10→9 tools), P0 safety (6 fixes), P1 ergonomics (8 fixes), structured search output, 128 unit tests, E2E validated** |
| v8.5–v8.6 | May 7–9, 2026 | isMajorSection WHITELIST, replace_entry, acquireLock TOCTOU, dedup 60%+500chars, memory_get search param, post-compact anti-refusal, snippet extraction fix, context sanitization, 10 critical bugfixes |
| v8.4 | May 2, 2026 | Per-session target isolation, SESSION LOG rotation, FTS5 cleanup, cross-target cleaner, post-compaction refusal fix, 19 search fixes |
| v8.3 | Apr 30, 2026 | 9 search fixes, vector v2.0 per-section, 5 hook fixes, writeback counter, template session summary, memory_timeline |
| v7.5 | Apr 10, 2026 | Vector search (MiniLM-L6-v2 + RRF), knowledge graph, contradiction detection, fuzzy matching, atomic writes |
| v7.0 | Apr 2026 | File-based storage (.md runbooks), FTS5 BM25, section-aware upsert, hard-block |
| v6.0 | Mar 2026 | Migration from SQLite to filesystem, YAML frontmatter |
| v5.0 | Feb 2026 | LRU cache, front-loading embedding, memory_list |
| v1.0 | Nov 2025 | Initial release: search, get, upsert, forget |

## Author

**sprindigo-art** — [GitHub](https://github.com/sprindigo-art)

## License

MIT
