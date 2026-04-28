import { useState, useEffect, useCallback } from 'react'
import { Globe, X, Loader2, AlertCircle, Copy, Check, Users, AlertTriangle } from 'lucide-react'
import { api, ApiError } from '../../lib/api'

export default function RuntimeControlsPanel({ onClose }) {
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const s = await api.getRuntimeStatus()
      setStatus(s)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { reload() }, [reload])

  const handleStartTunnel = async () => {
    if (!confirm("Start the public Cloudflare tunnel?\n\nAnyone with the URL + your auth token can drive sessions, run shell commands, and read your filesystem. Mint short-TTL invites in Settings → Invites for collaborators.")) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const r = await api.startTunnel()
      if (!r.ok) throw new Error(r.error || 'failed to start tunnel')
      await reload()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleStopTunnel = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.stopTunnel()
      await reload()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleToggleMP = async () => {
    if (!status) return
    setBusy(true)
    setError(null)
    try {
      await api.setMultiplayer(!status.multiplayer.enabled)
      await reload()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const copyUrl = async () => {
    const url = status?.tunnel?.url
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch { /* ignore */ }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-950 border border-zinc-800 rounded-lg w-full max-w-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <Globe size={16} className="text-indigo-400" />
            <div>
              <h2 className="text-zinc-100 text-sm font-semibold">Tunnel & Multiplayer</h2>
              <p className="text-zinc-500 text-[11px] mt-0.5">
                Control public exposure and collaborative previews at runtime.
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 text-zinc-500 hover:text-zinc-200">
            <X size={14} />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {error && (
            <div className="flex items-start gap-2 text-rose-400 text-[12px]">
              <AlertCircle size={14} className="mt-0.5" /> {error}
            </div>
          )}
          {loading && !status && (
            <div className="flex items-center gap-2 text-zinc-500 text-[12px]">
              <Loader2 size={14} className="animate-spin" /> Loading…
            </div>
          )}

          {status && (
            <>
              <section>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-zinc-200 text-[13px] font-medium flex items-center gap-2">
                      <Globe size={13} /> Cloudflare Tunnel
                    </div>
                    <div className="text-zinc-500 text-[11px] mt-0.5">
                      {status.tunnel.running
                        ? 'Active — server is reachable from the public internet.'
                        : 'Off — server is reachable on localhost / LAN only.'}
                    </div>
                  </div>
                  {status.tunnel.running ? (
                    <button
                      onClick={handleStopTunnel}
                      disabled={busy}
                      className="px-3 py-1.5 text-[12px] bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white rounded transition-colors flex items-center gap-1.5"
                    >
                      {busy && <Loader2 size={12} className="animate-spin" />}
                      Stop tunnel
                    </button>
                  ) : (
                    <button
                      onClick={handleStartTunnel}
                      disabled={busy}
                      className="px-3 py-1.5 text-[12px] bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded transition-colors flex items-center gap-1.5"
                    >
                      {busy && <Loader2 size={12} className="animate-spin" />}
                      Start tunnel
                    </button>
                  )}
                </div>

                {status.tunnel.running && status.tunnel.url && (
                  <div className="mt-3 bg-zinc-900 border border-zinc-800 rounded p-2 flex items-center gap-2">
                    <code className="text-[11px] text-zinc-200 flex-1 break-all font-mono">
                      {status.tunnel.url}
                    </code>
                    <button
                      onClick={copyUrl}
                      className="text-[10px] flex items-center gap-1 px-1.5 py-1 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
                    >
                      {copied ? <Check size={10} /> : <Copy size={10} />}
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                )}

                {status.tunnel.running && (
                  <div className="mt-3 flex items-start gap-2 text-amber-300/90 text-[11px] bg-amber-500/5 border border-amber-500/20 rounded p-2">
                    <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
                    <span>
                      Anyone with the URL + auth token has full shell access. Share via short-TTL invites, not the raw URL.
                    </span>
                  </div>
                )}
              </section>

              <div className="border-t border-zinc-800" />

              <section>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-zinc-200 text-[13px] font-medium flex items-center gap-2">
                      <Users size={13} /> Multiplayer
                    </div>
                    <div className="text-zinc-500 text-[11px] mt-0.5">
                      Enables the preview proxy so joiners can view your local dev servers.
                    </div>
                  </div>
                  <button
                    onClick={handleToggleMP}
                    disabled={busy}
                    className={`px-3 py-1.5 text-[12px] rounded transition-colors flex items-center gap-1.5 disabled:opacity-50 ${
                      status.multiplayer.enabled
                        ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                        : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200'
                    }`}
                  >
                    {busy && <Loader2 size={12} className="animate-spin" />}
                    {status.multiplayer.enabled ? 'Enabled' : 'Disabled'}
                  </button>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
