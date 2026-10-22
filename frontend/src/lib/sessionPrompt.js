const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
const QUESTION = /^\s*Do you want to proceed\?\s*$/i
const HEADER = /^\s*(?:Tool use|Bash command|Run command)\s*$/i
const OPTION = /^\s*([❯›>])?\s*([1-3])\.\s+(.+?)\s*$/

/** Parse a current screen, never historical scrollback, into explicit choices. */
export function parseSessionPermissionPrompt(screen) {
  if (typeof screen !== 'string' || !screen.trim()) return null
  const lines = screen.replace(ANSI, '').replace(/\r\n?/g, '\n').split('\n')
  let questionIndex = -1
  lines.forEach((line, index) => { if (QUESTION.test(line)) questionIndex = index })
  if (questionIndex < 0) return null
  // Hook confirmation dialogs use the actual tool name as their header.
  // Require its matching hook notice below it, not an arbitrary output line.
  const hookHeaders = new Map()
  lines.slice(0, questionIndex).forEach((line, index) => {
    const match = line.match(/^\s*[│|]?\s*Hook PreToolUse:([A-Za-z][\w:.-]*) requires confirmation for this tool:\s*$/)
    if (match) hookHeaders.set(match[1], index)
  })
  let excerptStart = -1
  for (let index = questionIndex - 1; index >= 0; index--) {
    if (HEADER.test(lines[index]) || hookHeaders.get(lines[index].trim()) > index) { excerptStart = index; break }
  }
  // A clipped footer does not describe what the user would approve.
  if (excerptStart < 0) return null
  const tail = lines.slice(questionIndex + 1)
  const footerIndex = tail.findIndex((line) => /^\s*Esc to cancel(?:\s*·\s*Tab to amend)?\s*$/.test(line))
  if (footerIndex < 0 || tail.slice(footerIndex + 1).some((line) => line.trim())) return null
  const choices = []
  let selections = 0
  for (const line of tail.slice(0, footerIndex)) {
    if (!line.trim()) continue
    const option = line.match(OPTION)
    if (option) {
      choices.push({ value: option[2], label: option[3] })
      if (option[1]) selections++
    } else if (choices.length && /^\s+\S/.test(line)) {
      choices[choices.length - 1].label += ` ${line.trim()}`
    } else {
      return null
    }
  }
  const numbers = choices.map((choice) => choice.value).join('')
  if (!['12', '123'].includes(numbers) || selections !== 1) return null
  if (choices[0].label !== 'Yes' || choices.at(-1).label !== 'No') return null
  if (choices.length === 3 && !/^Yes\b/.test(choices[1].label)) return null
  return { question: lines[questionIndex].trim(), choices, excerpt: lines.slice(excerptStart, questionIndex).join('\n').trim() }
}

/** Incomplete permission menus must not fall back to an unguarded manual choice. */
export function isSessionPermissionPromptFragment(screen) {
  if (typeof screen !== 'string' || !screen.trim() || parseSessionPermissionPrompt(screen)) return false
  const lines = screen.replace(ANSI, '').replace(/\r\n?/g, '\n').split('\n')
  return lines.some((line) => QUESTION.test(line)) || (
    lines.some((line) => /Esc to cancel/.test(line)) &&
    lines.some((line) => HEADER.test(line) || /^\s*[❯›>]?\s*[1-3][.)]\s+(?:Yes|No)\b/.test(line))
  )
}

export async function submitSessionPromptReply(sessionId, screen, reply, { sendInput, manual = false }) {
  const message = String(reply || '').trim()
  if (!sessionId || typeof screen !== 'string' || !screen.trim()) throw new Error('Refresh the current request before replying.')
  if (!message) throw new Error('Enter a reply first.')
  if (manual && (message.length > 2000 || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(message))) {
    throw new Error('Use a single line of text, up to 2,000 characters.')
  }
  if (isSessionPermissionPromptFragment(screen)) {
    throw new Error('The permission request is incomplete or not recognized. Refresh to show the full request before replying.')
  }
  if (!manual) {
    const prompt = parseSessionPermissionPrompt(screen)
    if (!prompt?.choices.some((choice) => choice.value === message)) throw new Error('This choice is not part of the current request. Refresh and review it again.')
  }
  const result = await sendInput(sessionId, message, {
    expected_screen: screen,
    ready_timeout: 0,
    ...(manual ? { prompt_reply: true } : {}),
  })
  if (!result?.ok || result.intercepted) throw new Error(result?.message || 'The assistant did not accept this reply.')
  return result
}

// Keep one-time approval, persistent approval, and refusal separate.
// A two-option menu has no persistent approval choice.
export function promptChoices(snapshot) {
  const prompt = snapshot?.prompt
  const choices = Array.isArray(prompt?.choices) ? prompt.choices : []
  const value = (index) => choices[index]?.value || null
  const recognized = choices.length === 2 || choices.length === 3
  return {
    allow: recognized ? value(0) : null,
    allowSession: choices.length === 3 ? value(1) : null,
    deny: recognized ? value(choices.length - 1) : null,
    labels: recognized ? choices.map((choice) => choice.label) : [],
    question: prompt?.question || '',
    excerpt: prompt?.excerpt || (snapshot?.screen ? snapshot.screen.slice(-8000) : ''),
  }
}
