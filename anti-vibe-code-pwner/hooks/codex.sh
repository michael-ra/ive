#!/bin/bash
# AVCP hook for Codex CLI (PreToolUse)
#
# Intercepts Bash tool calls containing package manager commands.
# Codex's hook contract mirrors Claude Code's (PreToolUse JSON in,
# permissionDecision JSON out), so this script is identical in shape
# to claude-code.sh — see that file for the rationale behind the
# plan-mode + shared-timeline integrations.
#
# Install: avcp setup codex
# Config:  ~/.codex/settings.json or .codex/settings.json

set -euo pipefail

AVCP_BIN="$(cd "$(dirname "$0")/.." && pwd)/avcp"
THRESHOLD="${AVCP_THRESHOLD:-7}"
# IVE sessions export COMMANDER_API_URL; :5111 is only the default install.
IVE_API="${IVE_API_URL:-${COMMANDER_API_URL:-http://127.0.0.1:5111}}"

# Read hook input from stdin
INPUT=$(cat)

# Extract command + session id (Claude Code injects session_id in PreToolUse).
COMMAND=$(echo "$INPUT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d.get('tool_input', {}).get('command', ''))
" 2>/dev/null) || exit 0

SESSION_ID=$(echo "$INPUT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d.get('session_id') or d.get('sessionId') or '')
" 2>/dev/null) || SESSION_ID=""

# Empty command — let it through
[[ -z "$COMMAND" ]] && exit 0

# ── Plan-mode bridge ─────────────────────────────────────────────────
# If IVE knows this session and it's in plan mode AND the command looks
# like a package install, force-deny up front. Curl with a short timeout
# so the hook never stalls when IVE is down.
PLAN_FORCED=0
PLAN_REASON=""
if [[ -n "$SESSION_ID" ]]; then
  PM=$(curl -fsS --max-time 1 "${IVE_API}/api/sessions/${SESSION_ID}/permission-mode" 2>/dev/null \
        | python3 -c "import sys,json; print(json.load(sys.stdin).get('permission_mode',''))" 2>/dev/null) || PM=""
  if [[ "$PM" == "plan" ]]; then
    # Treat any command that looks like it'd install/run packages as forbidden.
    # Conservative regex: only the verbs that fetch or execute.
    if [[ "$COMMAND" =~ (^|[[:space:];&|])(npm[[:space:]]+(install|i|add|exec|create)|yarn[[:space:]]+(add|create|dlx)|pnpm[[:space:]]+(add|install|i|dlx|create)|bun[[:space:]]+(add|install|i|create|x)|pip[[:space:]]+install|pip3[[:space:]]+install|uv[[:space:]]+(add|pip)|cargo[[:space:]]+install|gem[[:space:]]+install|go[[:space:]]+install|brew[[:space:]]+install|npx[[:space:]]) ]]; then
      PLAN_FORCED=1
      PLAN_REASON="Session is in Plan mode — package installs are blocked by IVE. Switch to Auto/Default in the Perms menu to allow installs."
    fi
  fi
fi

# ── POST decision back to IVE (best-effort, fire-and-forget) ─────────
_post_event() {
  local DECISION="$1" REASON="$2" FORCED="$3"
  [[ -z "$SESSION_ID" ]] && return 0
  # Use python to build the JSON body so we don't have to escape shell.
  local BODY
  BODY=$(SESSION_ID="$SESSION_ID" DECISION="$DECISION" COMMAND="$COMMAND" \
         REASON="$REASON" FORCED="$FORCED" python3 -c "
import json, os
print(json.dumps({
  'session_id': os.environ['SESSION_ID'],
  'decision':   os.environ['DECISION'],
  'command':    os.environ['COMMAND'][:500],
  'reason':     os.environ['REASON'][:500],
  'tool':       'Bash',
  'forced_by_plan_mode': os.environ['FORCED'] == '1',
}))") || return 0
  curl -fsS --max-time 1 -X POST "${IVE_API}/api/avcp/event" \
       -H 'Content-Type: application/json' -d "$BODY" >/dev/null 2>&1 || true
}

if [[ "$PLAN_FORCED" == "1" ]]; then
  _post_event "block" "$PLAN_REASON" "1"
  python3 -c "
import json
print(json.dumps({
  'hookSpecificOutput': {
    'hookEventName': 'PreToolUse',
    'permissionDecision': 'deny',
    'permissionDecisionReason': '''${PLAN_REASON}'''
  }
}))"
  exit 0
fi

# ── Standard AVCP supply-chain check ─────────────────────────────────
RESULT=$("$AVCP_BIN" intercept "$COMMAND" --threshold "$THRESHOLD" 2>/dev/null) || {
  # intercept not available or errored — don't block
  exit 0
}

DECISION=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('decision','allow'))" 2>/dev/null) || DECISION="allow"

if [[ "$DECISION" == "block" ]]; then
  REASON=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reason','Supply chain security check failed'))" 2>/dev/null)
  _post_event "block" "$REASON" "0"
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
  _post_event "warn" "$REASON" "0"
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
