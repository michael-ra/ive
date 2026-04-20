let audioCtx = null

function getContext() {
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume()
  }
  return audioCtx
}

/** Helper: play a sine tone with attack/decay envelope */
function tone(ctx, freq, vol, start, decay, type = 'sine') {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = type
  osc.frequency.value = freq
  gain.gain.setValueAtTime(0, start)
  gain.gain.linearRampToValueAtTime(vol, start + 0.008)
  gain.gain.exponentialRampToValueAtTime(0.001, start + decay)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(start)
  osc.stop(start + decay + 0.01)
}

/**
 * Session finished — satisfying two-note ascending chime (G5 → C6).
 * Feels like "task complete".
 */
export function playSessionDone(volume = 0.5) {
  try {
    const ctx = getContext()
    const now = ctx.currentTime
    const v = volume * 0.2
    // G5 then C6 — perfect fourth rise, warm completion feel
    tone(ctx, 783.99, v, now, 0.25)          // G5
    tone(ctx, 1046.5, v * 0.9, now + 0.12, 0.35) // C6
    // soft harmonic shimmer on the second note
    tone(ctx, 2093.0, v * 0.15, now + 0.13, 0.2) // C7 (octave above)
  } catch { /* audio unavailable */ }
}

/**
 * Agent completed — quick, light single tap. Unobtrusive since
 * agents complete frequently. A soft high "tick".
 */
export function playAgentDone(volume = 0.5) {
  try {
    const ctx = getContext()
    const now = ctx.currentTime
    const v = volume * 0.15
    // Single E6 with a tiny triangle-wave edge
    tone(ctx, 1318.5, v, now, 0.15, 'triangle')
    // faint sine octave for sparkle
    tone(ctx, 2637.0, v * 0.3, now, 0.1)
  } catch { /* audio unavailable */ }
}

/**
 * Plan ready for review — gentle three-note ascending melody (C5 → E5 → G5).
 * Musical doorbell that says "come look at this".
 */
export function playPlanReady(volume = 0.5) {
  try {
    const ctx = getContext()
    const now = ctx.currentTime
    const v = volume * 0.18
    // C major arpeggio, spaced for a doorbell rhythm
    tone(ctx, 523.25, v, now, 0.2)            // C5
    tone(ctx, 659.25, v, now + 0.13, 0.2)     // E5
    tone(ctx, 783.99, v * 1.1, now + 0.26, 0.35) // G5 (slightly louder, lingers)
    // soft shimmer on the top note
    tone(ctx, 1567.98, v * 0.12, now + 0.27, 0.18) // G6
  } catch { /* audio unavailable */ }
}

/**
 * Input / permission needed — two-note alert, slightly urgent.
 * A repeated knock: same note twice with a triangle timbre for edge.
 */
export function playInputNeeded(volume = 0.5) {
  try {
    const ctx = getContext()
    const now = ctx.currentTime
    const v = volume * 0.2
    // A5 played twice — "knock knock", triangle wave for a firmer feel
    tone(ctx, 880.0, v, now, 0.15, 'triangle')
    tone(ctx, 880.0, v * 0.85, now + 0.18, 0.15, 'triangle')
    // subtle sub-harmonic for weight
    tone(ctx, 440.0, v * 0.1, now, 0.12)
  } catch { /* audio unavailable */ }
}

/** Map of trigger keys to their sound functions. */
export const SOUNDS = {
  soundOnSessionDone: playSessionDone,
  soundOnAgentDone: playAgentDone,
  soundOnPlanReady: playPlanReady,
  soundOnInputNeeded: playInputNeeded,
}
