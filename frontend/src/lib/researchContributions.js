import { loadExtensionContributions } from './extensionRegistry'

// Research owns its jobs and drafts. Installed output destinations provide
// their own optional wire fields, without embedding those schemas in IVE.
export async function researchOutputOptions(context = {}) {
  const contributions = await loadExtensionContributions('researchOutputs')
  const parts = await Promise.all(contributions.map(contribution => contribution.options?.(context) || {}))
  return Object.assign({}, ...parts)
}
