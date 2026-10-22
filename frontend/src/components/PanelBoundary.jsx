import ErrorBoundary from './ErrorBoundary'

/** Lightweight error boundary for panels — dismisses on close instead of a full reload. */
export default function PanelBoundary({ onClose, children }) {
  return <PanelBoundaryInner onClose={onClose}>{children}</PanelBoundaryInner>
}

class PanelBoundaryInner extends ErrorBoundary {
  render() {
    if (this.state.error) {
      return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-x-scrim backdrop-blur-[4px]" onClick={this.props.onClose}>
          <div className="x-panel p-6 max-w-sm text-center" onClick={(e) => e.stopPropagation()}>
            <p className="text-xs font-medium text-x-accent-ink mb-2">Panel crashed</p>
            <pre className="text-[11px] text-x-muted font-mono mb-3 max-h-20 overflow-auto">{this.state.error?.message}</pre>
            <button onClick={this.props.onClose} className="h-[26px] px-3 text-xs font-medium border border-x-line text-x-ink-secondary hover:bg-x-hover hover:text-x-ink hover:border-x-line-strong rounded-md transition-colors duration-[80ms]">dismiss</button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
