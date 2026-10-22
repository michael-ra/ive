import { useEffect, useSyncExternalStore } from 'react'
import { ensureStarted, getQueue, subscribeQueue } from '../lib/composerQueue'

// This session's composer queue ({ items, hold }), live across tabs and reloads.
export function useComposerQueue(sessionId) {
  useEffect(() => { ensureStarted() }, [])
  return useSyncExternalStore(subscribeQueue, () => getQueue(sessionId), () => getQueue(sessionId))
}
