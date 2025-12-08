# MCP Cognitive Memory v9.8.3

> **Advanced AI Memory System** - Multi-Droid Support, Compression Recovery, Disconnect Recovery, Session Management.

## Core Features

### v9.8.x - Multi-Droid Isolation
- **Per-Droid Database**: Setiap Droid CLI instance punya database terpisah
- **No Conflict**: 2+ Droid bisa jalan bersamaan tanpa race condition
- **Shared Knowledge**: Memories tetap bisa diakses lintas instance

### v9.7.x - Disconnect Recovery
- **Single Instance Enforcement**: Auto-kill zombie processes
- **Graceful Shutdown**: SIGTERM, SIGINT, SIGHUP handlers
- **Exception Handling**: uncaughtException & unhandledRejection
- **Heartbeat Monitor**: 30s interval, detect dead parent
- **Auto-Reconnect**: 5 attempts dengan exponential backoff

### v8.x - Compression Hooks
- **Pre-Compression Save**: Auto-checkpoint sebelum context limit
- **Post-Compression Recovery**: Auto-detect dan recovery marker
- **Token Estimation**: Real-time monitoring context usage

### v7.x - Session Management
- **Session Tracking**: Per-day session dengan conversation history
- **Active Task**: Track task yang sedang dikerjakan
- **Auto-Bootstrap**: Load context otomatis di awal sesi
- **Work Logs**: Progress tracking antar sesi

## API Tools (15 Tools)

### Core Memory
| Tool | Description |
|------|-------------|
| `agi_store_memory` | Simpan knowledge dengan neural embedding |
| `agi_retrieve_context` | Smart search dengan semantic + recency boost |
| `agi_reinforce_memory` | SUCCESS untuk boost, POISON untuk hapus |
| `agi_run_dream_cycle` | Maintenance: dedupe, prune, summarize |

### Session Management
| Tool | Description |
|------|-------------|
| `agi_bootstrap_session` | **WAJIB** di awal sesi - load semua context |
| `agi_set_active_task` | Register task yang dikerjakan |
| `agi_complete_task` | Tandai task selesai |
| `agi_store_conversation` | Track conversation turns |
| `agi_get_session_summary` | Summary session saat ini |

### Compression Hooks
| Tool | Description |
|------|-------------|
| `agi_compression_status` | Cek token usage dan status |
| `agi_save_checkpoint` | Manual checkpoint sebelum operasi besar |
| `agi_check_compression` | Detect compression events |

### Error Tracking
| Tool | Description |
|------|-------------|
| `agi_report_memory_failure` | Report memory yang menyebabkan error |
| `agi_clear_memory_errors` | Clear error count setelah sukses |

## Installation

```bash
git clone https://github.com/sprindigo-art/mcp-memori.git
cd mcp-memori
npm install
```

## Configuration

```json
{
  "mcp-cognitive-memory": {
    "command": "node",
    "args": ["/path/to/mcp-memori/index.js"],
    "env": {
      "NODE_ENV": "production",
      "MEMORY_MODE": "god_mode"
    }
  }
}
```

## Quick Start

```javascript
// 1. Bootstrap di awal sesi
agi_bootstrap_session()

// 2. Set task
agi_set_active_task({ task_description: "Implementasi fitur X" })

// 3. Cari context relevan
agi_retrieve_context({ query: "fitur X lesson error", recursive: true })

// 4. Simpan progress
agi_store_memory({
  content: "Selesai implementasi fitur X dengan metode Y",
  tags: ["work_log", "fitur_x"],
  importance: 80
})

// 5. Selesai
agi_complete_task({ result: "completed" })
```

## Architecture

```
mcp-memori/
├── index.js              # Main server (v9.8.3)
├── package.json          # Dependencies
├── core_identity.md      # AI identity config
├── memory_god_mode_*.json # Per-droid databases
└── memory_*.json         # Shared data stores
```

## Key Improvements Over v6.0

| Aspect | v6.0 | v9.8.3 |
|--------|------|--------|
| Tools | 4 | 15 |
| Multi-Droid | No | Yes |
| Compression Recovery | No | Yes |
| Disconnect Recovery | No | Yes |
| Session Management | No | Yes |
| Error Auto-Tracking | No | Yes |
| Heartbeat Monitor | No | Yes |

## Dependencies

- `@modelcontextprotocol/sdk` - MCP Protocol
- `@xenova/transformers` - Neural embeddings
- `graphology` - Knowledge graph
- `lowdb` - JSON database
- `compute-cosine-similarity` - Vector similarity

## License

MIT

---
**Version**: 9.8.3-MULTI-DROID-ISOLATION-FIX  
**Status**: Production Ready
