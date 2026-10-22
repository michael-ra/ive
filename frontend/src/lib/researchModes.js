export const RESEARCH_MODES = [
  {
    key: 'technical_decision',
    label: 'Decision',
    hint: 'Tradeoffs, recommendation, and next work',
    section: 'Evaluate this as a technical decision. Compare evidence, tradeoffs, risks, and alternatives, then recommend concrete next development actions.',
  },
  {
    key: 'papers',
    label: 'Papers',
    hint: 'Literature, claims, and limitations',
    section: 'Find relevant papers. Compare claims, methods, evidence quality, and limitations, then identify techniques worth testing.',
  },
  {
    key: 'repos',
    label: 'Repos',
    hint: 'Libraries, APIs, license, and effort',
    section: 'Find relevant repositories and libraries. Compare maintenance, API shape, license, integration effort, and adoption risk.',
  },
  {
    key: 'competitors',
    label: 'Competitors',
    hint: 'Market moves, gaps, and positioning',
    section: 'Research competitors and adjacent products. Extract product moves, feature gaps, positioning, and company-level opportunities.',
  },
]

const MODE_MAP = new Map(RESEARCH_MODES.map((mode) => [mode.key, mode]))

export function normalizeResearchModes(modes) {
  const values = Array.isArray(modes) ? modes : [modes]
  const unique = [...new Set(values.filter((mode) => MODE_MAP.has(mode)))]
  return unique.length ? unique : ['technical_decision']
}

export function buildResearchQuery(topic, modes) {
  const cleanTopic = String(topic || '').trim()
  const selected = normalizeResearchModes(modes)
  const sections = selected.map((key) => {
    const mode = MODE_MAP.get(key)
    return `## ${mode.label}\n${mode.section}`
  })
  return [
    `Deep research brief: ${cleanTopic}`,
    ...sections,
    '## Synthesis\nReconcile evidence across the selected scopes, cite every material claim, surface disagreements and uncertainty, and finish with prioritized conclusions.',
  ].join('\n\n')
}

export function researchScopeForModes(modes) {
  return normalizeResearchModes(modes).includes('competitors') ? 'company' : 'workspace'
}

export function researchModeLabel(key) {
  return MODE_MAP.get(key)?.label || key
}
