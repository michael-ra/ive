// Build-time selection: uninstalled product UI is not imported into the bundle.
// Trusted local extensions only; this is not a sandbox for third-party JS.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const frontendRoot = path.dirname(fileURLToPath(import.meta.url))
const validId = /^[a-z][a-z0-9-]{0,63}$/
const virtualId = 'virtual:ive-extensions'
const resolvedId = '\0' + virtualId

export function selectExtensions(env = process.env) {
  const edition = (env.IVE_EDITION === undefined ? 'integrated-dev' : env.IVE_EDITION).trim()
  if (!['workspace', 'integrated-dev'].includes(edition)) throw new Error(`Unknown IVE_EDITION: ${edition}`)
  const roots = env.IVE_EXTENSION_PATHS !== undefined
    ? env.IVE_EXTENSION_PATHS.split(path.delimiter).filter(Boolean).map((root) => path.resolve(root))
    : edition === 'integrated-dev' ? [path.resolve(frontendRoot, '../../ive-extensions')] : []
  const selection = env.IVE_EXTENSIONS !== undefined
    ? new Set(env.IVE_EXTENSIONS.split(',').map((id) => id.trim()).filter(Boolean)) : null
  if (selection && [...selection].some((id) => !validId.test(id))) throw new Error('Invalid IVE_EXTENSIONS selection')
  const discovered = new Map()
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    for (const name of fs.readdirSync(root)) {
      if (!validId.test(name) || (selection ? !selection.has(name) : edition === 'workspace')) continue
      const manifest = path.join(root, name, 'extension.json')
      if (!fs.existsSync(manifest)) continue
      const realRoot = fs.realpathSync(root)
      const packageRoot = fs.realpathSync(path.dirname(manifest))
      if (!packageRoot.startsWith(realRoot + path.sep)) throw new Error(`Extension escapes configured root: ${name}`)
      if (!fs.realpathSync(manifest).startsWith(realRoot + path.sep)) throw new Error(`Extension manifest escapes configured root: ${name}`)
      const data = JSON.parse(fs.readFileSync(manifest, 'utf8'))
      if (data.id !== name || data.api_version !== 1) throw new Error(`Unsupported extension manifest: ${name}`)
      if (discovered.has(name)) throw new Error(`Duplicate extension installation: ${name}`)
      const requires = data.requires === undefined ? [] : data.requires
      if (!Array.isArray(requires) || requires.some((id) => typeof id !== 'string' || !validId.test(id))) {
        throw new Error(`Invalid extension dependencies: ${name}`)
      }
      discovered.set(name, { ...data, requires, root: packageRoot })
    }
  }
  function supported(id, visiting = new Set()) {
    const item = discovered.get(id)
    if (!item || visiting.has(id)) return false
    return (item.requires || []).every((dependency) => supported(dependency, new Set([...visiting, id])))
  }
  return [...discovered.values()].filter((item) => supported(item.id)).sort((a, b) => a.id.localeCompare(b.id))
}

export function iveExtensionPlugin() {
  const edition = (process.env.IVE_EDITION === undefined ? 'integrated-dev' : process.env.IVE_EDITION).trim()
  const selected = selectExtensions()
  const frontendEntries = selected.filter((item) => item.frontend?.entry).map((item) => {
    const target = path.resolve(item.root, item.frontend.entry)
    if (!target.startsWith(item.root + path.sep) || !fs.existsSync(target) || !fs.realpathSync(target).startsWith(item.root + path.sep)) {
      throw new Error(`Invalid frontend entry for extension ${item.id}`)
    }
    return { item, target }
  })
  const cssSources = [...new Set(frontendEntries.map(({ target }) => path.dirname(target)))]
  return {
    name: 'ive-product-extensions',
    enforce: 'pre',
    config() {
      return {
        resolve: {
          alias: { '@ive': path.join(frontendRoot, 'src') },
          dedupe: ['react', 'react-dom', 'zustand', 'lucide-react', 'mermaid', 'react-markdown', 'remark-gfm', 'prismjs'],
        },
        server: { fs: { allow: [frontendRoot, ...selected.map((item) => item.root)] } },
      }
    },
    resolveId(id) { if (id === virtualId) return resolvedId },
    transform(code, id) {
      // External product directories are outside Tailwind's default app scan.
      // Register only selected UI sources, never a blanket sibling-tree glob.
      if (!cssSources.length || !id.split('?')[0].endsWith('.css') || !/@(?:import|reference)\s+["']tailwindcss["']/.test(code)) return null
      return {
        code: code + '\n' + cssSources.map((source) => `@source ${JSON.stringify(source)};`).join('\n') + '\n',
        map: null,
      }
    },
    load(id) {
      if (id !== resolvedId) return
      const metadata = selected.map(({ id, api_version, ownership, visibility, requires }) => ({ id, api_version, ownership, visibility, requires }))
      const entries = []
      for (const { item, target } of frontendEntries) {
        entries.push(`${JSON.stringify(item.id)}: () => import(${JSON.stringify(target)})`)
        this.addWatchFile(path.join(item.root, 'extension.json'))
      }
      return `export const edition = ${JSON.stringify(edition)};\nexport const extensions = ${JSON.stringify(metadata)};\nexport const loaders = {${entries.join(',')}};\n`
    },
  }
}
