import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { parseInlineFormatting } from '../src/components/chat/ChatPanel.jsx'
import Notice from '../src/components/session/SessionContextNotice.jsx'
import store from '../src/state/store'



    const original = { id: 'source', name: 'Original', workspace_id: 'w', cli_type: 'claude', model: 'sonnet', status: 'idle', pty_alive: true }
    store.setState({ sessions: { source: original }, activeSessionId: 'source', activeWorkspaceId: 'w', ensureSessionRunning: async () => true })
    document.querySelector('#root').style.display = 'none'
    const root = document.createElement('main'); root.id = 'fixture'; root.style.cssText = 'padding:24px;font-size:16px;background:var(--x-surface);color:var(--x-ink);'; root.dataset.gridCellSession = 'source'; document.body.append(root)
    createRoot(root).render(h('div', null,
      h('h1', null, 'Overview links'),
      h('div', { id: 'links' }, ...[
        '**7. [Jens Rusitschka](https://example.org/jens)** · Founder, München',
        '**8. [Sam Dumont](https://example.org/posts/canary_(demo))** · Technical tester',
        '**9. [Max Tkacz](https://example.org/max)** — [Beleg](https://example.org/source)',
        'Bare URL: https://example.org/plain?name=ive&version=2.',
        '[Unsafe](javascript:alert(1)) and [Encoded](javascript%3Aalert(1))',
        '[Local file](/repo/src/app.js) and src/app.js',
      ].map((text, i) => h('p', { key: i }, parseInlineFormatting(text)))),
      h(Notice, { session: original, runtime: { context: { warning: true, input_tokens: 170000 } } }),
    ))
