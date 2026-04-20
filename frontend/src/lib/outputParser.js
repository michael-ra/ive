/**
 * Parse raw PTY terminal output to detect permission prompts, plans, and other patterns.
 * Strips ANSI codes for pattern matching while preserving the raw output for display.
 */

// Strips all ANSI escape sequences including:
// - CSI sequences: \x1b[...m, \x1b[?25l (DEC private mode), \x1b[>...
// - OSC sequences: \x1b]...BEL or \x1b]...\x1b\\
// - Character set designations: \x1b(A, \x1b)0
// - Shift in/out, carriage returns
const ANSI_RE = /\x1b\[[?>=!]?[0-9;]*[a-zA-Z~]|\x1b\].*?(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[>=<NOM78HDFE]|\x0f|\x0e|\r/g

export function stripAnsi(str) {
  return str.replace(ANSI_RE, '')
}

// Permission prompt detection — removed.
// Now handled by CLI lifecycle hooks (Notification event with permission_prompt type).
// See hooks.py _handle_notification().

// ─── Plan file path detection ───────────────────────────────────────────

const PLAN_FILE_RE = /~\/\.claude\/plans\/[\w-]+\.md/

// Buffer recent output per session for cross-batch detection
const _planBufs = new Map()

/**
 * Detects a plan file path like ~/.claude/plans/dreamy-dreaming-oasis.md
 * from Claude Code's plan mode output (e.g. "ctrl-g to edit in Vim · ~/.claude/plans/foo.md")
 * Uses a rolling buffer to handle paths split across output batches.
 */
export function detectPlanFile(text, sessionId) {
  const clean = stripAnsi(text)

  // Direct match on this chunk
  const m = clean.match(PLAN_FILE_RE)
  if (m) {
    if (sessionId) _planBufs.delete(sessionId)
    return { filePath: m[0] }
  }

  // Buffer last ~500 chars per session for cross-batch matching
  if (sessionId) {
    const prev = _planBufs.get(sessionId) || ''
    const combined = (prev + clean).slice(-500)
    _planBufs.set(sessionId, combined)
    const m2 = combined.match(PLAN_FILE_RE)
    if (m2) {
      _planBufs.delete(sessionId)
      return { filePath: m2[0] }
    }
  }

  return null
}

// Activity spinner detection — removed.
// Now handled by CLI lifecycle hooks (PreToolUse/PostToolUse events).
// See hooks.py _handle_pre_tool_use().

// User input / prompt detection — removed.
// Now handled by CLI lifecycle hooks (Stop and Notification events).
// See hooks.py _handle_stop() and _handle_notification().

// Legacy clearPromptBuffer kept as no-op for callers that haven't been updated.
export function clearPromptBuffer(_sessionId) {}

// ─── Plan / task list detection ─────────────────────────────────────────

/**
 * Returns { items: [{ text, checked?, index }] } if a plan-like structure is found.
 * Looks for numbered lists (1. 2. 3.) or checkbox items (- [ ] / - [x]).
 */
export function detectPlan(text) {
  const clean = stripAnsi(text)
  const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean)

  // Numbered list items (need at least 3 for confidence)
  const numbered = []
  for (const line of lines) {
    const m = line.match(/^(\d+)[\.\)]\s+(.+)/)
    if (m) {
      numbered.push({ index: parseInt(m[1]), text: m[2], original: line })
    }
  }
  if (numbered.length >= 3) {
    return { items: numbered }
  }

  // Checkbox items
  const checkboxes = []
  for (const line of lines) {
    const m = line.match(/^[-*]\s*\[([ xX])\]\s+(.+)/)
    if (m) {
      checkboxes.push({
        text: m[2],
        checked: m[1].toLowerCase() === 'x',
        original: line,
      })
    }
  }
  if (checkboxes.length >= 2) {
    return { items: checkboxes }
  }

  return null
}
