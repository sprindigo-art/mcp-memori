# MCP Cognitive Memory v14.0.0-OPTIMIZED

> **Advanced AI Memory System** - Multi-Instance Support, Compression Recovery, Semantic Search, Knowledge Graph.

## What's New in v14.0.0

- **11 Optimized Tools** (reduced from 15) - Removed rarely used tools
- **SafeStorage** - Multi-instance file locking (30s timeout)
- **100% Embedding Coverage** - All memories have semantic embeddings
- **Auto-Inject Lessons** - Lessons injected to ALL tool responses
- **Compact Responses** - Max 300 char per field
- **Graph Relations** - Auto-generate relations from content
- **Episodic Buffer** - Smart temporary memory detection

## Features

### Multi-Instance Support
- **File Locking**: 30s lock timeout, 7 retries
- **Safe for 2-3 AI simultaneously** (Droid CLI + Antigravity)
- **Zero data corruption** with concurrent access
- **Cross-model knowledge sharing** (Claude + Gemini)

### Compression Recovery
- **Auto-detect compression** via summary tags
- **Recovery instructions** with active task preservation
- **Session continuity** across compressions

### Semantic Search
- **Neural embeddings** via @xenova/transformers
- **Cosine similarity** with recency boost
- **Knowledge graph** with graphology

## API Tools (11 Tools)

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

// 2. Set active task
agi_set_active_task({ task_description: "Implement feature X" })

// 3. Get lessons before risky action
agi_get_lessons({ task_context: "feature X implementation" })

// 4. Retrieve relevant context
agi_retrieve_context({ query: "feature X lesson error" })

// 5. Store progress
agi_store_memory({
  content: "Completed feature X using method Y",
  tags: ["work_log", "feature_x"],
  importance: 80
})

// 6. Complete task
agi_complete_task({ result: "completed" })
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

## Architecture

```
mcp-memori/
├── index.js              # Main server (v14.0.0)
├── safe-storage.js       # Multi-instance file locking
├── package.json          # Dependencies
├── memory_god_mode.json  # Memory database (gitignored)
└── session_state.json    # Session state (gitignored)
```

## Performance

| Metric | Value |
|--------|-------|
| Total Memories | 275+ |
| Embedding Coverage | 100% |
| Lessons Stored | 21+ |
| Work Logs | 69+ |
| Sessions Tracked | 4+ |
| Concurrent Instances | 38+ tested |

## Version History

| Version | Changes |
|---------|---------|
| v14.0.0 | 11 tools, SafeStorage, compact responses |
| v13.0.0 | Graph relations, episodic buffer, clustering |
| v12.0.0 | Auto-inject lessons, summary detection |
| v11.0.0 | Compression detection, auto-cleanup |

## Dependencies

- `@modelcontextprotocol/sdk` - MCP Protocol
- `@xenova/transformers` - Neural embeddings
- `graphology` - Knowledge graph
- `proper-lockfile` - File locking
- `compute-cosine-similarity` - Vector similarity

## License

MIT

---
**Version**: 14.0.0-OPTIMIZED  
**Status**: Production Ready  
**Multi-Instance**: Safe for 2-3 AI simultaneously
