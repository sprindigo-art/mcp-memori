# MCP Cognitive Memory v14.3.0-BALANCED

> **Advanced AI Memory System** - Multi-Platform, Multi-AI Support, **Balanced Semantic Search**, Shared Database.

## What's New in v14.3.0

### CRITICAL FIXES - Balanced Semantic Search
- **FIX #1: recencyMultiplier CAPPED** - Now max 1.5x (was unlimited up to 6x!)
- **FIX #2: TAG MATCH PRIORITY** - Exact tag matches get strong boost (+0.35)
- **FIX #3: KEYWORD MATCH ENHANCED** - Query keywords in content get higher boost (+0.25)
- **FIX #4: REDUCED Work Log Boost** - Work logs won't dominate search results
- **FIX #5: RELEVANCE-FIRST FORMULA** - 70% semantic similarity, 30% recency

### Root Cause Fixed
Old relevant memories now rank HIGHER than new irrelevant ones!
- Before: Query "bypass Trae" returned unrelated work_logs (score 3-4)
- After: Query "bypass Trae" returns actual Trae memories (score 1.3-1.6)

### Retained from v14.2.0
- **Multi-Platform Support** - Linux, Windows, macOS
- **Multi-AI Detection** - Droid/Factory, Gemini/Antigravity, Claude, Trae
- **Per-AI Session State** - Each AI has separate session_state file (no conflicts)
- **Shared Database** - All AI learn from same lessons/memories
- **12 Total Tools**

## Features

### Multi-Platform Support
- **Linux**: `/home/user/.../mcp-memori/`
- **Windows**: `D:\path\to\mcp-memori\`
- **macOS**: `/Users/user/.../mcp-memori/`
- **Auto-detection** via `os.platform()`

### Multi-AI Support
| AI Platform | Detection Method | Session File |
|-------------|-----------------|--------------|
| Droid/Factory | `FACTORY_API_KEY`, parent process | `session_state_droid.json` |
| Gemini/Antigravity | `GOOGLE_AI_KEY`, parent process | `session_state_gemini.json` |
| Claude | `ANTHROPIC_API_KEY` | `session_state_claude.json` |
| Trae | `TRAE_SESSION` | `session_state_trae.json` |
| Unknown | Fallback | `session_state.json` |

### Multi-Instance Support
- **File Locking**: 30s lock timeout, 7 retries
- **Safe for 2-3 AI simultaneously** (Droid + Antigravity + Claude)
- **Zero data corruption** with concurrent access
- **Shared lessons** across all AI platforms

### Compression Recovery
- **Auto-detect compression** via summary tags
- **Recovery instructions** with active task preservation
- **Session continuity** across compressions

### Semantic Search
- **Neural embeddings** via @xenova/transformers
- **Cosine similarity** with recency boost
- **Knowledge graph** with graphology

## API Tools (12 Tools)

| Tool | Description | Use Case |
|------|-------------|----------|
| `agi_bootstrap_session` | Load session context | Start of session |
| `agi_retrieve_context` | Semantic search memories | Find relevant info |
| `agi_store_memory` | Store new memory | Save progress |
| `agi_get_lessons` | Get lessons before action | Prevent mistakes |
| `agi_detect_compression` | Detect compression | Recovery |
| `agi_auto_cleanup` | Cleanup stale memories | Maintenance |
| `agi_set_active_task` | Set current task | Task tracking |
| `agi_complete_task` | Mark task complete | Task tracking |
| `agi_store_conversation` | Store conversation | Context |
| `agi_reinforce_memory` | Boost/POISON memory | Quality control |
| `agi_deduplicate` | Remove duplicates | Maintenance |
| `get_memory_info` | **NEW** Platform, AI, DB stats | Debugging |

## Installation

```bash
git clone https://github.com/sprindigo-art/mcp-memori.git
cd mcp-memori
npm install
```

## Configuration

### For Droid CLI / Claude Desktop

```json
{
  "mcpServers": {
    "mcp-cognitive-memory": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/mcp-memori/index.js"],
      "env": {
        "NODE_ENV": "production",
        "MEMORY_MODE": "god_mode",
        "AUTO_SAVE": "true"
      }
    }
  }
}
```

## Quick Start

```javascript
// 1. Bootstrap at session start (MANDATORY)
agi_bootstrap_session()

// 2. Check platform and AI info
get_memory_info()

// 3. Set active task
agi_set_active_task({ task_description: "Implement feature X" })

// 4. Get lessons before risky action
agi_get_lessons({ task_context: "feature X implementation" })

// 5. Retrieve relevant context
agi_retrieve_context({ query: "feature X lesson error" })

// 6. Store progress
agi_store_memory({
  content: "Completed feature X using method Y",
  tags: ["work_log", "feature_x"],
  importance: 80
})

// 7. Complete task
agi_complete_task({ result: "completed" })
```

## Multi-AI Architecture

```
mcp-memori/
├── index.js                    # Main server (v14.2.0)
├── safe-storage.js             # Multi-instance file locking
├── package.json                # Dependencies
├── memory_god_mode.json        # SHARED database (all AI)
├── session_state_droid.json    # Droid session (per-AI)
├── session_state_gemini.json   # Gemini session (per-AI)
├── session_state_claude.json   # Claude session (per-AI)
├── session_state_trae.json     # Trae session (per-AI)
└── session_state.json          # Fallback (unknown AI)
```

## Compression Recovery

When you see `<summary>` or "A previous instance of Droid has summarized":

```javascript
// 1. Detect compression
agi_detect_compression({ context_hint: "A previous instance..." })

// 2. Bootstrap to recover context
agi_bootstrap_session()

// 3. Continue from active_task (don't start from scratch!)
```

## Performance

| Metric | Value |
|--------|-------|
| Total Memories | 390+ |
| Embedding Coverage | 100% |
| Lessons Stored | 27+ |
| Work Logs | 177+ |
| Sessions Tracked | 6+ |
| Concurrent AI | 4 supported |

## Version History

| Version | Changes |
|---------|---------|
| v14.2.0 | Multi-platform, multi-AI, per-AI session, get_memory_info |
| v14.1.0 | Fixed agi_get_lessons, expanded tags |
| v14.0.0 | 11 tools, SafeStorage, compact responses |
| v13.0.0 | Graph relations, episodic buffer, clustering |
| v12.0.0 | Auto-inject lessons, summary detection |

## Dependencies

- `@modelcontextprotocol/sdk` - MCP Protocol
- `@xenova/transformers` - Neural embeddings
- `graphology` - Knowledge graph
- `proper-lockfile` - File locking
- `async-lock` - Async mutex
- `compute-cosine-similarity` - Vector similarity

## License

MIT

---
**Version**: 14.2.0-MULTIPLATFORM  
**Status**: Production Ready  
**Multi-Platform**: Linux, Windows, macOS  
**Multi-AI**: Droid, Gemini, Claude, Trae  
**Tools**: 12
