#!/bin/bash
# utility-hooks.sh — Lightweight file/output utility hooks
# Modes: pre_read, post
# Crash-isolated from unified-intelligence.py (separate process)

set -o pipefail
MODE="${1:-post}"
INPUT=$(cat)

TOOL=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_name',''))" 2>/dev/null)
SESSION_ID=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id','default'))" 2>/dev/null)

# ═══════════════════════════════════════════════════
# MODE: pre_read — Deduplicate Read calls (block unchanged files)
# ═══════════════════════════════════════════════════
if [ "$MODE" = "pre_read" ]; then
    FILE=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('file_path',''))" 2>/dev/null)

    if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
        echo '{"decision": "approve"}'
        exit 0
    fi

    SEEN_FILE="/tmp/claude_read_seen_${SESSION_ID}.txt"
    MTIME=$(stat -c %Y "$FILE" 2>/dev/null || echo "0")
    KEY="${FILE}:${MTIME}"

    if grep -qxF "$KEY" "$SEEN_FILE" 2>/dev/null; then
        python3 -c "
import json
print(json.dumps({
    'decision': 'block',
    'reason': 'File unchanged since last read (same mtime). Content already in context.'
}))"
    else
        echo "$KEY" >> "$SEEN_FILE"
        # Keep seen file manageable
        if [ $(wc -l < "$SEEN_FILE" 2>/dev/null || echo 0) -gt 100 ]; then
            tail -60 "$SEEN_FILE" > "${SEEN_FILE}.tmp" && mv "${SEEN_FILE}.tmp" "$SEEN_FILE"
        fi
        echo '{"decision": "approve"}'
    fi
    exit 0
fi

# ═══════════════════════════════════════════════════
# MODE: post — PostToolUse dispatch by tool_name
# ═══════════════════════════════════════════════════
if [ "$MODE" = "post" ]; then

    # --- SUB: Enforce full-read (PostToolUse:Read) ---
    if [ "$TOOL" = "Read" ]; then
        FILE=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin).get('tool_input',{}); print(d.get('file_path',''))" 2>/dev/null)
        LIMIT=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin).get('tool_input',{}); print(d.get('limit',''))" 2>/dev/null)
        OFFSET=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin).get('tool_input',{}); print(d.get('offset',''))" 2>/dev/null)

        if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
            exit 0
        fi

        TOTAL_LINES=$(wc -l < "$FILE" 2>/dev/null || echo "0")
        if [ "$TOTAL_LINES" -le 2000 ]; then
            exit 0
        fi

        # Only enforce if "baca utuh" flag active
        FULL_READ_FLAG="/tmp/claude_force_full_read_${SESSION_ID}"
        if [ ! -f "$FULL_READ_FLAG" ]; then
            exit 0
        fi

        # Track progress
        CURRENT_OFFSET=${OFFSET:-0}
        CURRENT_LIMIT=${LIMIT:-2000}
        LINES_READ=$((CURRENT_OFFSET + CURRENT_LIMIT))

        if [ "$LINES_READ" -lt "$TOTAL_LINES" ]; then
            REMAINING=$((TOTAL_LINES - LINES_READ))
            NEXT_CHUNK=200
            [ "$REMAINING" -lt 200 ] && NEXT_CHUNK=$REMAINING

            python3 -c "
import json
print(json.dumps({
    'hookSpecificOutput': {
        'hookEventName': 'PostToolUse',
        'additionalContext': '[FULL-READ] File $FILE: $LINES_READ/$TOTAL_LINES lines. SISA $REMAINING. LANJUT: Read(file_path=\"$FILE\", offset=$LINES_READ, limit=$NEXT_CHUNK)'
    }
}))"
        else
            rm -f "/tmp/claude_fullread_${SESSION_ID}_$(echo "$FILE" | md5sum | cut -c1-8).txt" 2>/dev/null
            python3 -c "
import json
print(json.dumps({
    'hookSpecificOutput': {
        'hookEventName': 'PostToolUse',
        'additionalContext': '[FULL-READ COMPLETE] $FILE: $TOTAL_LINES/$TOTAL_LINES lines — SELESAI.'
    }
}))"
        fi
        exit 0
    fi

    # --- SUB: Smart truncate (PostToolUse:Bash) ---
    if [ "$TOOL" = "Bash" ]; then
        OUTPUT=$(echo "$INPUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
result = data.get('tool_response', {})
if isinstance(result, dict):
    print(result.get('stdout', '') + result.get('stderr', ''))
elif isinstance(result, str):
    print(result)
" 2>/dev/null)

        LINES=$(echo "$OUTPUT" | wc -l)

        if [ "$LINES" -gt 500 ]; then
            LOGFILE="/tmp/claude_bash_full_$(date +%s).log"
            echo "$OUTPUT" > "$LOGFILE"

            ERROR_LINES=$(echo "$OUTPUT" | grep -inE '(error|fail|denied|refused|timeout|not found|cannot|unable|blocked|invalid|exception|fatal|critical|warning)' | head -30)

            TRIMMED_COUNT=$((LINES - 230))

            python3 -c "
import json
print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PostToolUse', 'additionalContext': '[TRUNCATED] Output $LINES lines → 230 + errors. Full: $LOGFILE'}}))"
        fi
        exit 0
    fi

    # Other tools: no action
    exit 0
fi

# Default: no action
exit 0
