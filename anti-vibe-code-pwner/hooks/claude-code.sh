#!/bin/bash
# AVCP hook for Claude Code (PreToolUse)
#
# Intercepts Bash tool calls containing package manager commands.
# Reads JSON from stdin, checks packages, returns decision JSON to stdout.
#
# Install: avcp setup claude-code
# Config:  ~/.claude/settings.json or .claude/settings.json

set -euo pipefail

AVCP_BIN="$(cd "$(dirname "$0")/.." && pwd)/avcp"
THRESHOLD="${AVCP_THRESHOLD:-7}"

# Read hook input from stdin
INPUT=$(cat)

# Extract the command being run
COMMAND=$(echo "$INPUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('tool_input', {}).get('command', ''))
" 2>/dev/null) || exit 0

# Empty command — let it through
[[ -z "$COMMAND" ]] && exit 0

# Run intercept and capture result
RESULT=$("$AVCP_BIN" intercept "$COMMAND" --threshold "$THRESHOLD" 2>/dev/null) || {
  # intercept not available or errored — don't block
  exit 0
}

# Parse the result
DECISION=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('decision','allow'))" 2>/dev/null) || DECISION="allow"

if [[ "$DECISION" == "block" ]]; then
  REASON=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reason','Supply chain security check failed'))" 2>/dev/null)
  # Output Claude Code hook response
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
        'additionalContext': 'AVCP Warning: ' + '''${REASON}'''
    }
}))
"
else
  # Allow — check if there's context to add
  CONTEXT=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('context',''))" 2>/dev/null) || CONTEXT=""
  if [[ -n "$CONTEXT" ]]; then
    python3 -c "
import json
print(json.dumps({
    'hookSpecificOutput': {
        'hookEventName': 'PreToolUse',
        'permissionDecision': 'allow',
        'additionalContext': '''${CONTEXT}'''
    }
}))
"
  fi
  # No output = allow (default)
fi

exit 0
