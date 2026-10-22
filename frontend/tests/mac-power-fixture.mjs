// Build an isolated UI harness. All native actions are stubbed by the browser test.
import { build } from 'esbuild'
import { cp, mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = '/tmp/ive-mac-power-ui'
await mkdir(dir, { recursive: true })
await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import Panel from './src/components/settings/MacPowerPanel.jsx'; createRoot(document.getElementById('root')).render(<Panel/>);`, resolveDir: root, loader: 'jsx' }, bundle: true, jsx: 'automatic', format: 'esm', outfile: `${dir}/harness.js` })
await cp(`${root}/dist/assets`, `${dir}/assets`, { recursive: true })
await cp(`${root}/dist/fonts`, `${dir}/fonts`, { recursive: true })
const css = (await readdir(`${root}/dist/assets`)).find(name => /^index-.*\.css$/.test(name))
await writeFile(`${dir}/index.html`, `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/assets/${css}"></head><body style="background:var(--color-x-surface);margin:0"><div id="root" style="height:100vh"></div><script type="module" src="/harness.js"></script></body></html>`)
console.log(dir)
