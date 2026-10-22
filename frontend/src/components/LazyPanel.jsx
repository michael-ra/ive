import { Component, Suspense, lazy } from 'react'

// A chunk that fails to load is almost always a tab that outlived a rebuild
// (the old hashed files are gone). Other errors are not ours to handle.
const CHUNK_ERROR = /dynamically imported module|Importing a module script failed|Loading (CSS )?chunk|Unable to preload|module script/i
const isChunkError = (error) => error?.name === 'ChunkLoadError' || CHUNK_ERROR.test(String(error?.message || ''))

class ChunkBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    // Rethrowing from render hands the error to the next boundary up, so
    // panel bugs keep the PanelBoundary / app behaviour they had before.
    if (!isChunkError(error)) throw error
    return (
      <div role="alert" className="fixed bottom-4 right-4 z-[60] x-panel p-4 max-w-xs text-xs shadow-x-1" data-ive-chunk-error>
        <p className="font-medium text-x-ink mb-1">IVE was updated</p>
        <p className="text-x-muted mb-3">This part could not load because the app changed in the background. Reload to continue.</p>
        <div className="flex gap-2 justify-end">
          {this.props.onClose && (
            <button type="button" onClick={this.props.onClose} className="h-[26px] px-3 border border-x-line text-x-ink-secondary hover:bg-x-hover rounded-md">Dismiss</button>
          )}
          <button type="button" onClick={() => window.location.reload()} className="h-[26px] px-3 border border-x-line-strong text-x-ink hover:bg-x-hover rounded-md font-medium">Reload IVE</button>
        </div>
      </div>
    )
  }
}

// lazy() with its own Suspense and chunk-error boundary. The first open of
// one dialog no longer blanks sibling overlays sharing a Suspense, and a
// failed chunk shows "Reload IVE" instead of taking down the whole UI.
// `preload: 'idle'` fetches the chunk once the browser is idle.
export default function lazyPanel(loader, { preload } = {}) {
  const Lazy = lazy(loader)
  function LazyPanel(props) {
    return (
      <ChunkBoundary onClose={props.onClose}>
        <Suspense fallback={null}>
          <Lazy {...props} />
        </Suspense>
      </ChunkBoundary>
    )
  }
  LazyPanel.preload = () => loader().catch(() => {})
  if (preload === 'idle' && typeof window !== 'undefined') {
    const run = () => LazyPanel.preload()
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 4000 })
    else setTimeout(run, 2000)
  }
  return LazyPanel
}
