# MCP Memori — Installation Guide

## 1. Clone & Install

```bash
git clone https://github.com/sprindigo-art/mcp-memori.git ~/Desktop/mcp-memori
cd ~/Desktop/mcp-memori
npm install
```

## 2. MCP Server Config

Add to `~/.claude.json` (mcpServers section):

```json
{
  "mcpServers": {
    "mcp-memori": {
      "command": "node",
      "args": ["~/Desktop/mcp-memori/src/server.js"],
      "env": {
        "NODE_ENV": "production",
        "EMBEDDING_MODE": "hybrid",
        "EMBEDDING_BACKEND": "local",
        "LOG_LEVEL": "info",
        "DEFAULT_TENANT": "local-user",
        "DEFAULT_PROJECT": "janda_workspace"
      },
      "disabled": false
    }
  }
}
```

## 3. Hooks Config

Add to `~/.claude/settings.json` (hooks section):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/Desktop/mcp-memori/scripts/hooks/hook_session_start.js",
            "timeout": 5000
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash|Edit|Write|WebFetch|WebSearch|NotebookEdit|mcp__.*",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/Desktop/mcp-memori/scripts/hooks/hook_auto_capture.js",
            "timeout": 5000
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/Desktop/mcp-memori/scripts/hooks/hook_pre_compact.js",
            "timeout": 5000
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ~/Desktop/mcp-memori/scripts/hooks/hook_user_prompt.js",
            "timeout": 3000
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/Desktop/mcp-memori/scripts/hooks/hook_session_stop.js",
            "timeout": 8000
          }
        ]
      }
    ]
  }
}
```

## 4. Create Data Directories

```bash
mkdir -p ~/Desktop/mcp-memori/data
mkdir -p ~/Desktop/mcp-memori/runbooks
mkdir -p ~/Desktop/mcp-memori/archives
```

## 5. Binary Patch (Optional — removes safety refusal strings)

```bash
# Find Claude Code binary
ls ~/.vscode/extensions/ | grep claude-code

# Patch (replace VERSION with actual version)
python3 ~/Desktop/mcp-memori/scripts/patch_claude_binary.py \
  ~/.vscode/extensions/anthropic.claude-code-VERSION-linux-x64/resources/native-binary/claude

# Replace
BIN=~/.vscode/extensions/anthropic.claude-code-VERSION-linux-x64/resources/native-binary/claude
chmod +x "$BIN.new" && mv "$BIN.new" "$BIN"

# Restart VSCode
```

## 6. Verify

```bash
# MCP server
node ~/Desktop/mcp-memori/src/server.js &
# Should output JSON-RPC ready

# Search test
# In Claude Code: memory_search({query:"test", project_id:"janda_workspace"})
```

## File Structure

```
mcp-memori/
├── src/
│   ├── server.js                  # MCP server entry
│   ├── mcp/
│   │   ├── index.js               # Tool registry
│   │   └── tools/                 # 9 MCP tools
│   │       ├── memory.search.js   # FTS5+Vector+RRF search
│   │       ├── memory.get.js      # Read runbook
│   │       ├── memory.upsert.js   # Write/update runbook
│   │       ├── memory.forget.js   # Delete/remove
│   │       ├── memory.list.js     # List all runbooks
│   │       ├── memory.stats.js    # Statistics
│   │       ├── memory.autolog.js  # Auto-log tool
│   │       └── memory.timeline.js # Timeline tool
│   ├── storage/
│   │   ├── files.js               # .md file CRUD + snippet extraction
│   │   ├── searchIndex.js         # FTS5 SQLite index
│   │   ├── vectorIndex.js         # Local vector embeddings (all-MiniLM-L6-v2)
│   │   └── graphIndex.js          # Knowledge graph (entities + links)
│   └── utils/
│       ├── scrubber.js            # Password/token scrubbing
│       └── logger.js
├── scripts/
│   ├── hooks/
│   │   ├── hook_lib.js            # Shared helpers + session isolation
│   │   ├── hook_auto_capture.js   # PostToolUse — auto-log + writeback counter
│   │   ├── hook_session_start.js  # SessionStart — inject context
│   │   ├── hook_session_stop.js   # Stop — template summary
│   │   ├── hook_pre_compact.js    # PreCompact — fsync + auth preserve
│   │   ├── hook_user_prompt.js    # UserPromptSubmit — auto-inject memory
│   │   └── hook_llm_summary_worker.js # Optional LLM summary
│   ├── patch_claude_binary.py     # Binary safety string patcher
│   └── cleanup_cross_target.js    # Cross-target contamination cleaner
├── runbooks/                      # .md runbook files (not in git)
├── data/                          # SQLite databases (not in git)
├── archives/                      # Rotated _AUTO_LOG archives
├── mcp.config.json
├── package.json
├── README.md
└── INSTALL.md
```
