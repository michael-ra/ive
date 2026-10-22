// A device-local layout choice, shared by the visible button and keyboard
// shortcut. Storage failures must never prevent opening the navigation.
export const SIDEBAR_VISIBILITY_KEY = 'ive.sidebar-visible'

export function readSidebarVisibility(storage) {
  try {
    return (storage ?? globalThis.localStorage)?.getItem(SIDEBAR_VISIBILITY_KEY) !== 'false'
  } catch {
    return true
  }
}

export function persistSidebarVisibility(store, getStorage = () => globalThis.localStorage) {
  return store.subscribe((state, previous) => {
    if (state.sidebarVisible === previous.sidebarVisible) return
    try {
      getStorage()?.setItem(SIDEBAR_VISIBILITY_KEY, String(state.sidebarVisible))
    } catch { /* The control remains usable if browser storage is unavailable. */ }
  })
}
