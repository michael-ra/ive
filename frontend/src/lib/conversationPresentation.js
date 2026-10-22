// Presentation only: the unchanged live screen remains the authority for replies.
const cleanLines = (text) => String(text || '').split('\n').map((line) => line.trim()).filter((line) => line && !/^[─━╌┄│┆\s]+$/.test(line))

export function permissionPresentation(prompt) {
  const lines = cleanLines(prompt?.excerpt)
  const kind = lines.shift() || ''
  const description = lines[0] || 'Review the requested action'
  const setupIssue = /missing API key|not configured|fail.closed/i.test(prompt?.excerpt || '')
  return {
    title: /^(Bash command|Run command)$/i.test(kind) ? 'Allow this action?' : 'Allow access?',
    description,
    notice: setupIssue ? 'An additional IVE safety check needs setup. Changing the agent mode does not fix this check. Review the exact request before deciding.' : '',
    choices: (prompt?.choices || []).map((choice, index) => ({
      ...choice,
      label: choice.label === 'No' ? 'Don’t allow' : choice.label === 'Yes' ? 'Allow once' : choice.label,
      kind: choice.label === 'No' ? 'deny' : index === 0 ? 'allow' : 'persistent',
    })),
  }
}

export function activityLabel(steps, running) {
  if (!running) return `Activity · ${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`
  const step = steps.at(-1)
  const tool = step?.tool_use
  if (typeof tool?.input?.description === 'string' && tool.input.description.trim()) return tool.input.description.trim()
  const name = String(tool?.name || '').toLowerCase()
  if (/search_memory/.test(name)) return 'Checking project context'
  if (/search|grep|glob/.test(name)) return 'Finding relevant files'
  if (/read/.test(name)) return 'Reading project files'
  if (/write|edit|patch/.test(name)) return 'Updating files'
  if (/bash|shell|exec/.test(name)) return 'Running a project command'
  if (name) return 'Working with a connected service'
  return 'Working on your request'
}

export function hasVisibleMessage(content) {
  if (typeof content === 'string') {
    if (/^\s*[\[{]/.test(content)) {
      try { return hasVisibleMessage(JSON.parse(content)) } catch {}
    }
    return Boolean(content.trim())
  }
  if (Array.isArray(content)) return content.some(hasVisibleMessage)
  if (!content || typeof content !== 'object') return false
  if (content.type === 'thinking' || content.type === 'redacted_thinking') return false
  if (content.type === 'text') return Boolean(String(content.text || '').trim())
  return true // Images, files and other rich content must remain visible.
}
