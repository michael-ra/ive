import { useEffect, useState } from 'react'
import { Smartphone, X, Share2 } from 'lucide-react'
import useMediaQuery from '../../hooks/useMediaQuery'

const DISMISSED_KEY = 'cc-pwa-install-dismissed-v1'

function isStandalone() {
  if (typeof window === 'undefined') return false
  if (window.matchMedia('(display-mode: standalone)').matches) return true
  if (window.navigator && window.navigator.standalone) return true
  return false
}

function isIOS() {
  if (typeof navigator === 'undefined') return false
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream
}

export default function MobileInstallPrompt() {
  const isMobile = useMediaQuery('(max-width: 767px)')
  const [dismissed, setDismissed] = useState(
    typeof localStorage !== 'undefined' ? !!localStorage.getItem(DISMISSED_KEY) : true,
  )
  const [deferredPrompt, setDeferredPrompt] = useState(null)

  useEffect(() => {
    const handler = (e) => {
      e.preventDefault()
      setDeferredPrompt(e)
    }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  if (!isMobile || dismissed || isStandalone()) return null

  const dismiss = () => {
    try { localStorage.setItem(DISMISSED_KEY, '1') } catch {}
    setDismissed(true)
  }

  const install = async () => {
    if (!deferredPrompt) return
    deferredPrompt.prompt()
    try { await deferredPrompt.userChoice } catch {}
    setDeferredPrompt(null)
    dismiss()
  }

  const ios = isIOS()

  return (
    <div className="fixed bottom-3 left-3 right-3 z-40 bg-x-surface border border-x-line rounded-lg shadow-x-1 p-3 text-xs">
      <div className="flex items-start gap-2">
        <Smartphone size={14} className="text-x-accent mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-x-ink mb-1">Install IVE on your home screen</div>
          {ios ? (
            <div className="text-x-ink-secondary text-[11px] leading-relaxed">
              Tap <Share2 size={11} className="inline mx-0.5 text-x-accent" /> Share, then{' '}
              <span className="font-medium text-x-ink">Add to Home Screen</span>. Push
              notifications work after that.
            </div>
          ) : (
            <div className="text-x-ink-secondary text-[11px] leading-relaxed">
              Get a standalone app, faster launches, and push notifications.
            </div>
          )}
        </div>
        <button
          type="button"
          aria-label="Dismiss install suggestion"
          onClick={dismiss}
          className="p-0.5 text-x-faint hover:text-x-ink-secondary"
        >
          <X size={13} />
        </button>
      </div>
      {!ios && deferredPrompt && (
        <button
          onClick={install}
          className="w-full mt-2 py-1.5 bg-x-accent text-x-on-accent text-xs font-medium rounded-md hover:bg-x-accent-ink transition-colors duration-[80ms] active:scale-[.98]"
        >
          Install
        </button>
      )}
    </div>
  )
}
