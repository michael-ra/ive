#!/bin/bash
# AVCP hook for Gemini CLI (BeforeTool)
#
# Intercepts shell_execute tool calls containing package manager commands.
# Reads JSON from stdin, returns exit 0/2 (Gemini's hook contract).
# All logging goes to stderr — only final JSON to stdout.
#
# Integrations (mirror claude-code.sh):
#   • Plan-mode bridge — if the IVE session is in plan mode, force-deny
#     any package install regardless of AVCP's freshness verdict.
#   • Shared timeline — POST every block/warn back to IVE so the activity
#     feed shows AVCP decisions inline with session events.
# Both are best-effort: a 1s curl timeout means the hook degrades to its
# original AVCP-only behaviour when IVE isn't reachable.
#
# Install: avcp setup gemini-cli
# Config:  ~/.gemini/settings.json or .gemini/settings.json

set -euo pipefail

AVCP_BIN="$(cd "$(dirname "$0")/.." && pwd)/avcp"
THRESHOLD="${AVCP_THRESHOLD:-7}"
# IVE sessions export COMMANDER_API_URL; :5111 is only the default install.
IVE_API="${IVE_API_URL:-${COMMANDER_API_URL:-http://127.0.0.1:5111}}"

INPUT=$(cat)

COMMAND=$(echo "$INPUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
tool_input = data.get('tool_input', data.get('input', {}))
cmd = tool_input.get('command', tool_input.get('script', ''))
print(cmd)
" 2>/dev/null) || exit 0

SESSION_ID=$(echo "$INPUT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d.get('session_id') or d.get('sessionId') or '')
" 2>/dev/null) || SESSION_ID=""

[[ -z "$COMMAND" ]] && exit 0

echo "AVCP: checking command: $COMMAND" >&2

# ── Plan-mode bridge (mirror of claude-code.sh) ─────────────────────
if [[ -n "$SESSION_ID" ]]; then
  PM=$(curl -fsS --max-time 1 "${IVE_API}/api/sessions/${SESSION_ID}/permission-mode" 2>/dev/null \
        | python3 -c "import sys,json; print(json.load(sys.stdin).get('permission_mode',''))" 2>/dev/null) || PM=""
  if [[ "$PM" == "plan" ]]; then
    if [[ "$COMMAND" =~ (^|[[:space:];&|])(npm[[:space:]]+(install|i|add|exec|create)|yarn[[:space:]]+(add|create|dlx)|pnpm[[:space:]]+(add|install|i|dlx|create)|bun[[:space:]]+(add|install|i|create|x)|pip[[:space:]]+install|pip3[[:space:]]+install|uv[[:space:]]+(add|pip)|cargo[[:space:]]+install|gem[[:space:]]+install|go[[:space:]]+install|brew[[:space:]]+install|npx[[:space:]]) ]]; then
      PLAN_REASON="Session is in Plan mode — package installs are blocked by IVE. Switch to Auto/Default in the Perms menu to allow installs."
      _post_event_plan=$(SESSION_ID="$SESSION_ID" COMMAND="$COMMAND" REASON="$PLAN_REASON" python3 -c "
import json, os
print(json.dumps({
  'session_id': os.environ['SESSION_ID'],
  'decision':   'block',
  'command':    os.environ['COMMAND'][:500],
  'reason':     os.environ['REASON'][:500],
  'tool':       'shell_execute',
  'forced_by_plan_mode': True,
}))") || _post_event_plan=""
      [[ -n "$_post_event_plan" ]] && \
        curl -fsS --max-time 1 -X POST "${IVE_API}/api/avcp/event" \
             -H 'Content-Type: application/json' -d "$_post_event_plan" >/dev/null 2>&1 || true
      echo "AVCP: BLOCKED (plan mode) — $PLAN_REASON" >&2
      echo "$PLAN_REASON" >&2
      exit 2
    fi
  fi
fi

# ── Shared timeline helper ──────────────────────────────────────────
_post_event() {
  local DECISION="$1" REASON="$2"
  [[ -z "$SESSION_ID" ]] && return 0
  local BODY
  BODY=$(SESSION_ID="$SESSION_ID" DECISION="$DECISION" COMMAND="$COMMAND" \
         REASON="$REASON" python3 -c "
import json, os
print(json.dumps({
  'session_id': os.environ['SESSION_ID'],
  'decision':   os.environ['DECISION'],
  'command':    os.environ['COMMAND'][:500],
  'reason':     os.environ['REASON'][:500],
  'tool':       'shell_execute',
  'forced_by_plan_mode': False,
}))") || return 0
  curl -fsS --max-time 1 -X POST "${IVE_API}/api/avcp/event" \
       -H 'Content-Type: application/json' -d "$BODY" >/dev/null 2>&1 || true
}

# ── Standard AVCP supply-chain check ────────────────────────────────
RESULT=$("$AVCP_BIN" intercept "$COMMAND" --threshold "$THRESHOLD" 2>/dev/null) || exit 0

DECISION=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('decision','allow'))" 2>/dev/null) || DECISION="allow"

if [[ "$DECISION" == "block" ]]; then
  REASON=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reason','Supply chain security check failed'))" 2>/dev/null)
  _post_event "block" "$REASON"
  echo "AVCP: BLOCKED — $REASON" >&2
  echo "$REASON" >&2
  exit 2
elif [[ "$DECISION" == "warn" ]]; then
  REASON=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reason',''))" 2>/dev/null)
  _post_event "warn" "$REASON"
  echo "AVCP: WARNING — $REASON" >&2
  echo "$REASON" >&2
  exit 2
fi

exit 0
