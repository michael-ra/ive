// Local visual fixture for environments that cannot start a server/browser process.
// Bundles the real component and lifecycle hook; only HTTP responses are simulated.
import { build } from 'esbuild'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const result = await build({
  stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import Guide from './src/components/onboarding/FirstLaunchOnboarding.jsx';
    import useOnboarding from './src/hooks/useOnboarding.js';
    window.fetch = async (url, options = {}) => {
      const path = String(url).replace(/^.*\\/api/, '');
      const data = JSON.parse(localStorage.getItem('ive.qa.guide.settings') || '{}');
      if (path === '/whoami') return Response.json({ actor_kind: 'localhost' });
      if (path.startsWith('/settings/')) {
        const key = path.slice('/settings/'.length);
        if (options.method === 'PUT') {
          if (sessionStorage.getItem('ive.qa.fail-save')) return Response.json({error:'QA save error'}, {status:503});
          data[key] = JSON.parse(options.body).value;
          localStorage.setItem('ive.qa.guide.settings', JSON.stringify(data));
          return Response.json({ok:true});
        }
        return Response.json({value:data[key] || null});
      }
      return Response.json([]);
    };
    function Fixture() {
      const tour = useOnboarding();
      const [destination, setDestination] = useState('Übersicht');
      return <><main className="x-app-shell" style={{padding:48}}><h1>IVE · Testansicht</h1><p>Aktueller Bereich: {destination}</p><button onClick={tour.show}>IVE kennenlernen</button><p>Diese lokale Testansicht ist mit keinem Backend verbunden.</p></main>{tour.open && <Guide profile={tour.profile} onFinish={tour.finish} onNavigate={setDestination}/>}</>;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);
  ` },
  bundle: true, write: false, format: 'iife', jsx: 'automatic', minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{ name: 'qa-profile', setup(plugin) {
    plugin.onResolve({ filter: /^virtual:ive-extensions$/ }, () => ({ path: 'profile', namespace: 'qa' }))
    plugin.onLoad({ filter: /.*/, namespace: 'qa' }, () => ({ contents: 'export const edition="integrated-dev", extensions=[{id:"sandbox"}], loaders={};' }))
    plugin.onLoad({ filter: /onboarding\.css$/ }, () => ({ contents: '', loader: 'js' }))
  } }],
})
const assets = join(root, 'dist/assets')
const cssFile = (await readdir(assets)).find((name) => name.startsWith('index-') && name.endsWith('.css'))
let css = await readFile(join(assets, cssFile), 'utf8')
for (const font of (await readdir(join(root, 'public/fonts'))).filter((name) => name.endsWith('.woff2'))) {
  const data = (await readFile(join(root, 'public/fonts', font))).toString('base64')
  css = css.replaceAll(`/fonts/${font}`, `data:font/woff2;base64,${data}`)
}
// Use the current CSS even if the last application build predates a visual fix.
css += await readFile(join(root, 'src/components/onboarding/onboarding.css'), 'utf8')
const inner = `<!doctype html><html lang="de" data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><body><div id="root"></div><script>${result.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script></body></html>`
const html = `<!doctype html><html lang="de"><meta charset="utf-8"><title>IVE – Einführung prüfen</title><style>body{margin:0;font:14px system-ui;background:#ddd}header{display:flex;gap:12px;padding:12px;align-items:center}button{padding:7px 12px}iframe{display:block;border:0;margin:auto;width:1280px;height:940px;max-width:100%}</style><header><strong>IVE · Lokale Prüfung</strong><button onclick="frame.style.width='1280px'">Desktop</button><button onclick="frame.style.width='390px'">Mobil 390</button><button onclick="frame.style.width='320px'">Mobil 320</button><button onclick="frame.contentDocument.documentElement.dataset.theme='dark'">Dunkel</button><button onclick="frame.contentDocument.documentElement.dataset.theme='light'">Hell</button><button onclick="localStorage.removeItem('ive.qa.guide.settings');localStorage.removeItem('ive.onboarding.v1.owner');frame.srcdoc=source">Erststart zurücksetzen</button><button onclick="sessionStorage.setItem('ive.qa.fail-save','1')">Speicherfehler</button><button onclick="sessionStorage.removeItem('ive.qa.fail-save')">Speichern erlauben</button></header><iframe id="frame" title="IVE-Einführung"></iframe><script>const source=${JSON.stringify(inner).replaceAll('</script','<\\/script')};frame.srcdoc=source;</script></html>`
const output = '/private/tmp/ive-onboarding-preview.html'
await writeFile(output, html)
console.log(output)
