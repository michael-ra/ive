#!/bin/bash
# AVCP hook for Codex CLI (PreToolUse)
#
# Intercepts shell commands containing package manager operations.
# Reads JSON from stdin and returns Claude-style hookSpecificOutput JSON.

set -euo pipefail

AVCP_BIN="$(cd "$(dirname "$0")/.." && pwd)/avcp"
THRESHOLD="${AVCP_THRESHOLD:-7}"

INPUT=$(cat)

COMMAND=$(echo "$INPUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
tool_input = data.get('tool_input', data.get('input', {}))
print(tool_input.get('command', tool_input.get('script', '')))
" 2>/dev/null) || exit 0

[[ -z "$COMMAND" ]] && exit 0

RESULT=$("$AVCP_BIN" intercept "$COMMAND" --threshold "$THRESHOLD" 2>/dev/null) || exit 0
DECISION=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('decision','allow'))" 2>/dev/null) || DECISION="allow"

if [[ "$DECISION" == "block" ]]; then
  REASON=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reason','Supply chain security check failed'))" 2>/dev/null)
  python3 -c "
import json
print(json.dumps({
    'hookSpecificOutput': {
        'hookEventName': 'PreToolUse',
        'permissionDecision': 'deny',
        'permissionDecisionReason': '''${REASON}'''
    }
}))
"
elif [[ "$DECISION" == "warn" ]]; then
  REASON=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reason',''))" 2>/dev/null)
  python3 -c "
import json
print(json.dumps({
    'hookSpecificOutput': {
        'hookEventName': 'PreToolUse',
        'permissionDecision': 'ask',
        'permissionDecisionReason': 'AVCP Warning: ' + '''${REASON}'''
    }
}))
"
fi

exit 0
