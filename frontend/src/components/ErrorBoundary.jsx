import { Component } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, errorInfo: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, errorInfo) {
    this.setState({ errorInfo })
    console.error('ErrorBoundary caught:', error, errorInfo)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex items-center justify-center h-full bg-x-bg">
          <div className="text-center p-8 max-w-md">
            <AlertTriangle size={32} className="text-x-accent-ink mx-auto mb-4" />
            <h2 className="text-sm font-medium text-x-ink mb-2">Something went wrong</h2>
            <pre className="text-[11px] text-x-accent-ink/80 font-mono mb-4 text-left bg-x-surface-2 border border-x-line rounded-lg p-3 overflow-auto max-h-32">
              {this.state.error?.message || 'Unknown error'}
            </pre>
            <button
              onClick={() => {
                this.setState({ error: null, errorInfo: null })
                window.location.reload()
              }}
              className="flex items-center gap-1.5 mx-auto h-[30px] px-4 text-[13px] font-medium bg-x-accent hover:bg-x-accent-ink text-x-on-accent rounded-md transition-colors duration-[80ms] active:scale-[.98]"
            >
              <RefreshCw size={13} />
              reload
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
