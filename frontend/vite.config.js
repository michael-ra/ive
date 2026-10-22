import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { iveExtensionPlugin, selectExtensions } from './extension-build.mjs'
import { reviewedProductSelection } from './reviewed-products.mjs'

// Exported as frontend/vite.config.js. Both dev and build ignore env files and
// inherited product selections; they use the same explicit profile as Python.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const expected = {
  schema_version: 1, name: 'ive-team', edition: 'integrated-dev',
  extensions: ['sandbox'], extension_root: 'extensions', state_directory: '.ive-team-state',
}
const profile = JSON.parse(fs.readFileSync(path.join(root, 'ive-team.json'), 'utf8'))
if (Object.keys(profile).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([key, value]) => JSON.stringify(profile[key]) !== JSON.stringify(value))) {
  throw new Error('The frontend requires the unmodified IVE team profile')
}
process.env.IVE_EDITION = profile.edition
// Direct npm and launcher builds independently rehash the same explicit config;
// inherited environment selection is never evidence of operator approval.
const selection = reviewedProductSelection(root)
process.env.IVE_EXTENSIONS = selection.extensions.join(',')
process.env.IVE_EXTENSION_PATHS = selection.roots.join(path.delimiter)
if (JSON.stringify(selectExtensions().map(({ id }) => id)) !== JSON.stringify(selection.extensions)) {
  throw new Error('Every selected extension and its dependencies must be present')
}
const buildProfile = Object.fromEntries(['schema_version', 'name', 'edition', 'extensions'].map((key) => [key, profile[key]]))
buildProfile.extensions = selection.extensions
if (Object.keys(selection.fingerprints).length) buildProfile.product_fingerprints = selection.fingerprints

export default defineConfig({
  envDir: false,
  plugins: [
    iveExtensionPlugin(), react(), tailwindcss(),
    {
      name: 'ive-team-build-profile',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'ive-build-profile.json', source: JSON.stringify(buildProfile, null, 2) + '\n' })
      },
    },
  ],
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:5111', ws: true },
      '/ws': { target: 'http://127.0.0.1:5111', ws: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Function form on purpose: the object form let Rollup place Vite's
        // shared preload helper and react/jsx-runtime into the mermaid and
        // markdown chunks, so the 640 kB mermaid chunk was downloaded and
        // parsed on every start although diagrams are loaded on demand.
        // Mermaid is only reached through import() and splits by itself.
        manualChunks(id) {
          if (!id.includes('/node_modules/')) return undefined
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react'
          if (id.includes('/node_modules/@xterm/')) return 'xterm'
          if (id.includes('/node_modules/prismjs/')) return 'prism'
          return undefined
        },
      },
    },
  },
})
