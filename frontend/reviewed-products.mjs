// Explicit local product inventory validation shared by direct/launcher builds.
// No network, subprocess, writes, sibling discovery, or executable product load.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex')
const validId = /^[a-z][a-z0-9-]{0,63}$/
const exactKeys = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) &&
  Object.keys(object).sort().join(',') === [...keys].sort().join(',')
// Match Python's Unicode-codepoint sort and compact UTF-8 JSON encoding. Build
// the JSON members directly: JS objects reorder integer-looking property keys.
const unicodeCompare = (left, right) => {
  const a = Array.from(left, (item) => item.codePointAt(0))
  const b = Array.from(right, (item) => item.codePointAt(0))
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]
  return a.length - b.length
}
const canonicalInventory = (object) => '{' + Object.keys(object).sort(unicodeCompare)
  .map((key) => JSON.stringify(key) + ':' + JSON.stringify(object[key])).join(',') + '}'
const fail = () => { throw new Error('Invalid or changed explicitly reviewed local product configuration') }

export function reviewedProductSelection(suppliedRoot) {
  const root = fs.realpathSync(suppliedRoot)
  const configPath = path.join(root, 'ive-local.json')
  let config = { schema_version: 1 }
  const configInfo = fs.lstatSync(configPath, { throwIfNoEntry: false })
  if (configInfo) {
    if (configInfo.isSymbolicLink() || !configInfo.isFile()) fail()
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  }
  if (!config || typeof config !== 'object' || Array.isArray(config) || config.schema_version !== 1 ||
      Object.keys(config).some((key) => !['schema_version', 'products', 'sandbox'].includes(key))) fail()
  const products = config.products === undefined ? [] : config.products
  if (!Array.isArray(products)) fail()
  const selection = { extensions: ['sandbox'], roots: [path.join(root, 'extensions')], fingerprints: {} }
  const manifests = new Map()
  for (const product of products) {
    if (!exactKeys(product, ['id', 'path', 'files']) || typeof product.id !== 'string' || !validId.test(product.id) ||
        selection.extensions.includes(product.id) || typeof product.path !== 'string' || !path.isAbsolute(product.path)) fail()
    const packageRoot = product.path
    if (!fs.statSync(packageRoot).isDirectory() || fs.lstatSync(packageRoot).isSymbolicLink() ||
        fs.realpathSync(packageRoot) !== packageRoot || path.basename(packageRoot) !== product.id ||
        packageRoot === root || packageRoot.startsWith(root + path.sep)) fail()
    const inventory = product.files
    if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory) || !inventory['extension.json'] ||
        Object.entries(inventory).some(([key, value]) => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) fail()
    const actual = Object.create(null)
    function visit(directory) {
      for (const name of fs.readdirSync(directory)) {
        const file = path.join(directory, name)
        const info = fs.lstatSync(file)
        if (info.isSymbolicLink()) fail()
        if (info.isDirectory()) {
          if (name.startsWith('.') || ['node_modules', '__pycache__'].includes(name)) fail()
          visit(file)
        } else if (info.isFile()) {
          if (name.startsWith('.env') || ['.db', '.sqlite', '.sqlite3', '.pyc'].includes(path.extname(name))) fail()
          actual[path.relative(packageRoot, file).split(path.sep).join('/')] = digest(fs.readFileSync(file))
        } else fail()
      }
    }
    visit(packageRoot)
    if (canonicalInventory(actual) !== canonicalInventory(inventory)) fail()
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'extension.json'), 'utf8'))
    if (manifest.id !== product.id || manifest.api_version !== 1 ||
        (fs.existsSync(path.join(packageRoot, 'backend/database.py')) && !manifest.backend?.storage)) fail()
    const dependencies = manifest.requires === undefined ? [] : manifest.requires
    if (!Array.isArray(dependencies) || dependencies.some((id) => typeof id !== 'string' || !validId.test(id))) fail()
    manifests.set(product.id, dependencies)
    selection.extensions.push(product.id)
    selection.roots.push(path.dirname(packageRoot))
    selection.fingerprints[product.id] = digest(canonicalInventory(inventory))
  }
  function dependenciesReady(id, pending = new Set()) {
    if (pending.has(id)) fail()
    for (const dependency of manifests.get(id) ?? []) {
      if (!selection.extensions.includes(dependency)) fail()
      dependenciesReady(dependency, new Set([...pending, id]))
    }
  }
  for (const id of manifests.keys()) dependenciesReady(id)
  selection.extensions.sort()
  selection.roots = [...new Set(selection.roots)]
  return selection
}
