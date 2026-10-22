import { loadExtensionContributions } from './extensionRegistry'

// Optional output destinations observe a completed local discovery action.
// The caller keeps its local state if a destination is missing or fails.
export async function publishDiscoveryEvent(event, context) {
  const contributions = await loadExtensionContributions('discoveryOutputs')
  const outputs = contributions.filter(contribution =>
    Object.prototype.hasOwnProperty.call(contribution, event) && typeof contribution[event] === 'function')
  await Promise.all(outputs.map(contribution => contribution[event](context)))
  return outputs.length
}
