#!/bin/bash
# AVCP hook for Gemini CLI (BeforeTool)
#
# Intercepts shell_execute tool calls containing package manager commands.
# Reads JSON from stdin, checks packages, returns decision JSON to stdout.
# All logging goes to stderr — only final JSON to stdout.
#
# Install: avcp setup gemini-cli
# Config:  ~/.gemini/settings.json or .gemini/settings.json

set -euo pipefail

AVCP_BIN="$(cd "$(dirname "$0")/.." && pwd)/avcp"
THRESHOLD="${AVCP_THRESHOLD:-7}"

# Read hook input from stdin
INPUT=$(cat)

# Extract the command — Gemini CLI uses different tool input shapes
COMMAND=$(echo "$INPUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
tool_input = data.get('tool_input', data.get('input', {}))
# Gemini CLI shell tool uses 'command' or 'script'
cmd = tool_input.get('command', tool_input.get('script', ''))
print(cmd)
" 2>/dev/null) || exit 0

[[ -z "$COMMAND" ]] && exit 0

# All diagnostic output to stderr
echo "AVCP: checking command: $COMMAND" >&2

RESULT=$("$AVCP_BIN" intercept "$COMMAND" --threshold "$THRESHOLD" 2>/dev/null) || exit 0

DECISION=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('decision','allow'))" 2>/dev/null) || DECISION="allow"

if [[ "$DECISION" == "block" ]]; then
  REASON=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reason','Supply chain security check failed'))" 2>/dev/null)
  echo "AVCP: BLOCKED — $REASON" >&2
  # Gemini CLI: exit 2 = critical block
  echo "$REASON" >&2
  exit 2
elif [[ "$DECISION" == "warn" ]]; then
  REASON=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reason',''))" 2>/dev/null)
  echo "AVCP: WARNING — $REASON" >&2
  # Block by default — warn is treated as deny until user approves
  echo "$REASON" >&2
  exit 2
fi

# Default: allow (exit 0, no stdout)
exit 0
