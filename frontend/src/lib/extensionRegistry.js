import { createElement, lazy, Suspense } from 'react'
import { edition, extensions, loaders } from 'virtual:ive-extensions'

// No imports from product directories here. Vite composes only the selected
// installations. A hidden panel is not a substitute for this build boundary.
const ids = new Set(extensions.map((extension) => extension.id))
const panels = new Map()
const entries = new Map()

export const installedExtensions = extensions
export const activeEdition = edition
export const isExtensionAvailable = (id) => ids.has(id)

function loadExtensionEntry(extensionId) {
  if (!isExtensionAvailable(extensionId) || typeof loaders[extensionId] !== 'function') {
    return Promise.reject(new Error(`Extension ${extensionId} is not installed or enabled`))
  }
  if (!entries.has(extensionId)) {
    const pending = Promise.resolve().then(() => loaders[extensionId]())
    entries.set(extensionId, pending)
    // Permit retry after a transient chunk-load failure; concurrent callers
    // share one in-flight import, and a late rejection cannot erase a retry.
    pending.catch(() => {
      if (entries.get(extensionId) === pending) entries.delete(extensionId)
    })
  }
  return entries.get(extensionId)
}

export async function callExtensionApi(extensionId, method, ...args) {
  const entry = await loadExtensionEntry(extensionId)
  const handler = entry.api && Object.prototype.hasOwnProperty.call(entry.api, method)
    ? entry.api[method] : null
  if (typeof handler !== 'function') {
    throw new Error(`Extension ${extensionId} does not provide API method ${method}`)
  }
  return handler(...args)
}

// Optional, product-owned contributions (for example workspace form defaults
// and serialization). Only selected entries load; host code never knows their
// setting keys or wire formats. A failed load must be surfaced by the caller.
export async function loadExtensionContributions(name) {
  const contributions = await Promise.all(extensions
    .filter((extension) => typeof loaders[extension.id] === 'function')
    .map(async (extension) => {
      const entry = await loadExtensionEntry(extension.id)
      return Object.prototype.hasOwnProperty.call(entry, name) ? entry[name] : null
    }))
  return contributions.filter(Boolean)
}

export function resolveExtensionPanel(extensionId, panelName) {
  const key = `${extensionId}:${panelName}`
  if (panels.has(key)) return panels.get(key)
  if (!isExtensionAvailable(extensionId) || !loaders[extensionId]) {
    const AbsentExtension = () => null
    panels.set(key, AbsentExtension)
    return AbsentExtension
  }
  const Panel = lazy(async () => {
    const entry = await loadExtensionEntry(extensionId)
    const component = entry.panels?.[panelName]
    if (!component) throw new Error(`Missing panel ${panelName} in extension ${extensionId}`)
    return { default: component }
  })
  function ExtensionPanel(props) {
    return createElement(Suspense, { fallback: null }, createElement(Panel, props))
  }
  ExtensionPanel.displayName = `Extension(${key})`
  panels.set(key, ExtensionPanel)
  return ExtensionPanel
}

// Transitional ownership mapping until all surfaces register from their owner.
// The remaining mixed panels are deliberately NOT represented as extracted.
const extractedSurfaceOwners = {
  'code-catalog': 'forge',
  'agent-systems': 'agentario',
  'ai-control-center': 'gi',
  'gi-companion': 'gi',
  'app-directory': 'company',
  'morning-digest': 'company',
}

// These implementations have NOT been extracted yet. Keep legacy-only UI in
// the same compatibility profile as its backend, without calling it a plugin.
const legacyOnlySurfaces = new Set([
  'secure', 'research', 'research-active', 'research-library',
  'observatory', 'smart-observatory', 'discovery-insights', 'discovery',
  'discovery-setup', 'pipeline-editor',
])
export function isSurfaceAvailable(id) {
  if (legacyOnlySurfaces.has(id)) return edition === 'integrated-dev'
  const owner = extractedSurfaceOwners[id]
  return !owner || isExtensionAvailable(owner)
}
