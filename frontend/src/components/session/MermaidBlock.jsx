import { useEffect, useRef, useState } from 'react'

let mermaidReady = null // shared init promise

function xColor(name, fallback) {
  if (typeof document === 'undefined') return fallback
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

async function ensureMermaid() {
  if (!mermaidReady) {
    mermaidReady = import('mermaid').then(m => {
      m.default.initialize({
        startOnLoad: false,
        theme: 'base',
        themeVariables: {
          primaryColor: xColor('--x-surface', '#FFFFFF'),
          primaryTextColor: xColor('--x-ink', '#16181A'),
          primaryBorderColor: xColor('--x-accent', '#1647FF'),
          lineColor: xColor('--x-muted', '#8A8F98'),
          secondaryColor: xColor('--x-surface-2', '#F3F2EF'),
          tertiaryColor: xColor('--x-bg', '#F4F5F6'),
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
      <div className="my-2 p-2 border border-x-accent-ink/30 rounded-md bg-x-accent-ink/10 text-[11px] text-x-accent-ink">
        <div className="font-medium mb-1 text-x-accent-ink/80">Mermaid error</div>
        {error}
        <pre className="mt-1 font-mono text-x-faint whitespace-pre-wrap">{code}</pre>
      </div>
    )
  }

  if (!svg) {
    return <div className="my-2 h-16 bg-x-surface-2 rounded animate-pulse" />
  }

  return (
    <div
      ref={ref}
      className="my-2 p-3 bg-x-surface-2 border border-x-line-subtle rounded-md overflow-x-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
