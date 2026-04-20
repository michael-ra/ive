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
        <div className="flex items-center justify-center h-full bg-bg-primary">
          <div className="text-center p-8 max-w-md">
            <AlertTriangle size={32} className="text-red-400 mx-auto mb-4" />
            <h2 className="text-[11px] text-zinc-200 font-mono font-medium mb-2">Something went wrong</h2>
            <pre className="text-[11px] text-red-400/70 font-mono mb-4 text-left bg-[#111118] rounded p-3 overflow-auto max-h-32">
              {this.state.error?.message || 'Unknown error'}
            </pre>
            <button
              onClick={() => {
                this.setState({ error: null, errorInfo: null })
                window.location.reload()
              }}
              className="flex items-center gap-1 mx-auto px-4 py-1.5 text-[11px] font-mono bg-indigo-600 hover:bg-indigo-500 text-white rounded transition-colors"
            >
              <RefreshCw size={12} />
              reload
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
