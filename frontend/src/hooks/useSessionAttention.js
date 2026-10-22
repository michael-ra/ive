import { useEffect } from 'react'
import useStore, { attentionStamp } from '../state/store'
import { request } from '../lib/api'
import { detectTerminalAttention } from '../lib/sessionAttention'

export default function useSessionAttention() {
  useEffect(() => {
    let stopped = false, timer, controller
    async function refresh() {
      controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 12000)
      const versions = Object.fromEntries(Object.values(useStore.getState().sessions).map((s) => [s.id, attentionStamp(s)]))
      try {
        const sessions = await request('/sessions', { signal: controller.signal })
        if (stopped || !Array.isArray(sessions)) return
        // A small worker pool also covers sessions whose terminals are closed.
        const queue = [...sessions]
        await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
          while (queue.length && !stopped) {
            const session = queue.shift()
            try {
              let attention = session.attention
              if (!Object.hasOwn(session, 'attention') && session.pty_alive && ['claude', 'codex'].includes(session.cli_type)) {
                const output = await request(`/sessions/${encodeURIComponent(session.id)}/output?lines=80`, { signal: controller.signal })
                attention = detectTerminalAttention(output.screen || output.text)
                // Old servers do not have a durable snapshot. Absence of a
                // terminal match cannot clear a structured hook request.
                if (!attention && useStore.getState().sessions[session.id]?.attention?.source !== 'terminal') continue
              }
              if (stopped || attention === undefined) continue
              const store = useStore.getState(), current = store.sessions[session.id]
              // Never let an HTTP response undo a newer WebSocket event.
              if (!current || attentionStamp(current) !== (versions[session.id] || '0:0')) continue
              if (attention?.source === 'terminal' && attention.context === current.resolvedAttentionContext) continue
              if (JSON.stringify(current.attention || null) !== JSON.stringify(attention || null)) store.setSessionAttention(session.id, attention || null)
            } catch { /* A single vanished session must not hide other requests. */ }
          }
        }))
      } catch { /* Connection status is already displayed by the app. */ }
      finally {
        clearTimeout(timeout)
        if (!stopped) timer = setTimeout(refresh, 5000)
      }
    }
    refresh()
    return () => { stopped = true; clearTimeout(timer); controller?.abort() }
  }, [])
}
