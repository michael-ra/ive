import { useEffect, useRef, useState } from 'react'

let mermaidReady = null // shared init promise

async function ensureMermaid() {
  if (!mermaidReady) {
    mermaidReady = import('mermaid').then(m => {
      m.default.initialize({
        startOnLoad: false,
        theme: 'dark',
        themeVariables: {
          primaryColor: '#1e3a5f',
          primaryTextColor: '#e0e0e0',
          primaryBorderColor: '#3b82f6',
          lineColor: '#6b7280',
          secondaryColor: '#1e293b',
          tertiaryColor: '#0f172a',
          fontFamily: 'ui-monospace, monospace',
          fontSize: '12px',
        },
      })
      return m.default
    })
  }
  return mermaidReady
}

let renderCounter = 0

export default function MermaidBlock({ code }) {
  const ref = useRef(null)
  const [svg, setSvg] = useState('')
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    const id = `mermaid-${++renderCounter}`
    ;(async () => {
      try {
        const mermaid = await ensureMermaid()
        const { svg: rendered } = await mermaid.render(id, code)
        if (!cancelled) {
          setSvg(rendered)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) {
          setError(e.message || 'Mermaid render failed')
          setSvg('')
        }
        // Clean up failed render element
        document.getElementById(id)?.remove()
      }
    })()
    return () => { cancelled = true }
  }, [code])

  if (error) {
    return (
      <div className="my-2 p-2 border border-red-500/20 rounded bg-red-500/5 text-[10px] text-red-400 font-mono">
        <div className="text-[9px] uppercase tracking-wider mb-1 text-red-400/60">Mermaid error</div>
        {error}
        <pre className="mt-1 text-text-faint whitespace-pre-wrap">{code}</pre>
      </div>
    )
  }

  if (!svg) {
    return <div className="my-2 h-16 bg-bg-inset rounded animate-pulse" />
  }

  return (
    <div
      ref={ref}
      className="my-2 p-3 bg-bg-inset border border-border-secondary rounded-md overflow-x-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
