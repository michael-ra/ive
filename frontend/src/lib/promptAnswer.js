// Answering the agent's native prompt from outside the terminal (Home card,
// board card, session PermissionCard). Only the current screen can authorize
// an answer: the backend compares `expected_screen` and refuses with 409
// stale_session_prompt when the dialog changed. Callers reload after a 409
// and never resend.
import { api } from './api.js'
import { isSessionPermissionPromptFragment, parseSessionPermissionPrompt, submitSessionPromptReply } from './sessionPrompt.js'

export const PROMPT_SNAPSHOT_LINES = 60

// → { sessionId, screen, prompt, incomplete }
export async function fetchPromptSnapshot(sessionId) {
  const output = await api.getSessionOutput(sessionId, PROMPT_SNAPSHOT_LINES, { permission_view: true })
  // Only the current screen can authorize an action; text is scrollback.
  const screen = typeof output?.screen === 'string' ? output.screen : ''
  return {
    sessionId,
    screen,
    prompt: parseSessionPermissionPrompt(screen),
    incomplete: isSessionPermissionPromptFragment(screen),
    startupBlocker: output?.startup_blocker || null,
    viewState: output?.permission_view_state || null,
  }
}

export { promptChoices } from './sessionPrompt.js'

export function isStalePromptError(err) {
  return err?.body?.code === 'stale_session_prompt'
}

export function promptErrorMessage(err) {
  if (isStalePromptError(err)) {
    return err.body.partial
      ? 'The request changed while your reply was being entered. Review the refreshed request and any text already in its input before replying again.'
      : 'The request changed before your reply was sent. Review the refreshed request and choose again.'
  }
  return err?.body?.startup_blocker?.label || err?.message || 'Reply was not sent. Please try again.'
}

// Sends `value` ("1" | "2" | "3", or free text with manual: true) against the
// screen in `snapshot`. Throws the ApiError on 409 (err.body.code).
export async function answerPrompt(sessionId, snapshot, value, { manual = false } = {}) {
  const screen = snapshot?.screen
  return submitSessionPromptReply(sessionId, screen, value, { sendInput: api.sendSessionInput, manual })
}
