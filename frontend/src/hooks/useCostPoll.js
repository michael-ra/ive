import { useEffect } from 'react'
import useStore from '../state/store'
import { loadCosts } from '../lib/costs'

const POLL_MS = 60000
const IDLE_DEBOUNCE_MS = 5000

// Mounted once in App: loads cost and token figures at start, every minute
// and (debounced) when a turn ends. Mocked backends answer [] for /cost;
// loadCosts turns that into empty figures.
export default function useCostPoll({ enabled = true } = {}) {
  useEffect(() => {
    if (!enabled) return undefined
    let disposed = false
    let debounce = null
    let lastRun = 0
    const run = async () => {
      lastRun = Date.now()
      try {
        const { bySession, today } = await loadCosts({ sessions: useStore.getState().sessions })
        if (!disposed) useStore.getState().setSessionCosts(bySession, today)
      } catch { /* the next tick tries again; cards show the last figures */ }
    }
    const onIdle = () => {
      clearTimeout(debounce)
      const wait = Math.max(0, IDLE_DEBOUNCE_MS - (Date.now() - lastRun))
      debounce = setTimeout(run, wait)
    }
    run()
    const interval = setInterval(run, POLL_MS)
    window.addEventListener('cc-session-messages-refresh', onIdle)
    return () => {
      disposed = true
      clearInterval(interval)
      clearTimeout(debounce)
      window.removeEventListener('cc-session-messages-refresh', onIdle)
    }
  }, [enabled])
}
