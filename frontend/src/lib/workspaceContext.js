export const WORKSPACE_CONTEXT_QUESTIONS = [
  {
    key: 'vision', label: 'What does this project do?',
    placeholder: 'For example: A website where customers can book a bicycle repair.',
    memoryName: 'Product vision', memoryDescription: 'Project purpose provided when connecting the workspace.',
  },
  {
    key: 'constraints', label: 'What should the agent keep in mind?',
    placeholder: 'For example: Keep the existing booking flow. Use our current colors. Check changes on mobile.',
    memoryName: 'Project constraints', memoryDescription: 'Requirements and things to preserve, provided when connecting the workspace.',
  },
  {
    key: 'audience', label: 'Who will use it?', advanced: true,
    placeholder: 'Describe the people you are building this for.',
    memoryName: 'Target audience', memoryDescription: 'Who the product is built for.',
  },
  {
    key: 'competitors', label: 'Similar products or useful references', advanced: true,
    placeholder: 'Names or links, and what you want to learn from them.',
    memoryName: 'Competitor radar', memoryDescription: 'Comparable products and references named by the user.',
  },
  {
    key: 'differentiator', label: 'What should be different about this project?', advanced: true,
    placeholder: 'For example: Simpler booking for people who prefer not to create an account.',
    memoryName: 'Differentiator', memoryDescription: 'How this project differs from comparable products.',
  },
]

export const emptyWorkspaceContext = () => Object.fromEntries(WORKSPACE_CONTEXT_QUESTIONS.map(({ key }) => [key, '']))

export function mergeWorkspaceAutofill(answers, result, savedKeys = []) {
  const next = { ...answers }
  for (const { key } of WORKSPACE_CONTEXT_QUESTIONS) {
    const incoming = typeof result?.[key] === 'string' ? result[key].trim() : ''
    if (incoming && !next[key]?.trim() && !savedKeys.includes(key)) next[key] = incoming
  }
  return next
}

// Checkpoint each confirmed write. A later failure must not recreate fields
// that already saved successfully when the user retries this form.
export function createWorkspaceContextSaver(api, workspaceId) {
  const saved = new Set()
  let pending = null
  return {
    getSavedKeys: () => [...saved],
    save(answers, onSaved = () => {}) {
      if (pending) return pending
      pending = (async () => {
        for (const question of WORKSPACE_CONTEXT_QUESTIONS) {
          const content = (answers[question.key] || '').trim()
          if (!content || saved.has(question.key)) continue
          const entry = await api.createMemoryEntry({
            type: 'project', name: question.memoryName, description: question.memoryDescription,
            content, workspace_id: workspaceId, source_cli: 'commander', tags: ['onboarding', 'vision'],
          })
          if (!entry?.id) throw new Error('The server did not confirm this answer was saved. Check Context Hub before retrying.')
          saved.add(question.key)
          onSaved([...saved])
        }
        return [...saved]
      })().finally(() => { pending = null })
      return pending
    },
  }
}
