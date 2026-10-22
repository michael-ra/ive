import { useEffect, useState } from 'react'
import MobileDrawer from '../layout/MobileDrawer'
import TerminalKeepAlive from './TerminalKeepAlive'

// The frame every screen sits in. Desktop: [sidebar 240 px | main: header
// 44 px › screen › footer 28 px (only when set)] plus the side chat next to
// main and one TerminalKeepAlive at the end of main. Phone: the drawer with
// the sidebar, the phone header and the screen. `prelude` (install prompts,
// cost panel …) and `overlays` (modals, toasts) stay inside .x-app-shell so
// the onboarding's `inert` covers them.
function useVisualViewport(isMobile) {
  // Soft keyboard: the visual viewport is clearly shorter than the tallest one
  // seen at this width. Mobile then hides secondary chrome so the input and
  // terminal keep their room (see [data-keyboard-open] in index.css). iOS
  // scrolls the layout viewport to show a focused input above the keyboard;
  // the phone shell follows the visual viewport's top as well.
  const [vvHeight, setVvHeight] = useState(null)
  const [vvTop, setVvTop] = useState(0)
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  useEffect(() => {
    const refit = () => window.dispatchEvent(new Event('cc-terminal-refit'))
    let timer = null
    let tallest = { width: 0, height: 0 }
    const update = () => {
      const vv = window.visualViewport
      setVvHeight(vv ? vv.height : null)
      if (!vv) return
      setVvTop(Math.max(0, Math.round(vv.offsetTop || 0)))
      if (vv.width !== tallest.width || vv.height > tallest.height) tallest = { width: vv.width, height: vv.height }
      setKeyboardOpen(vv.height < tallest.height * 0.75)
    }
    const debounced = () => {
      update()
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { refit(); setTimeout(refit, 250) }, 60)
    }
    const vv = window.visualViewport
    if (vv) {
      vv.addEventListener('resize', debounced)
      vv.addEventListener('scroll', debounced)
      update()
    }
    window.addEventListener('orientationchange', debounced)
    return () => {
      if (timer) clearTimeout(timer)
      if (vv) {
        vv.removeEventListener('resize', debounced)
        vv.removeEventListener('scroll', debounced)
      }
      window.removeEventListener('orientationchange', debounced)
    }
  }, [])
  return { vvHeight, vvTop, keyboardOpen: isMobile && keyboardOpen }
}

export default function AppShell({
  isMobile = false, sidebarVisible = true, mobileDrawerOpen = false, onMobileDrawerClose,
  mobileView, phoneLevel,
  sidebar, header, mobileHeader, footer, prelude, sideChat, overlays, children,
}) {
  const { vvHeight, vvTop, keyboardOpen } = useVisualViewport(isMobile)

  return (
    <div
      className="x-app-shell flex flex-col overflow-hidden x-canvas"
      data-mobile-view={isMobile ? mobileView : undefined}
      data-phone-level={isMobile ? phoneLevel : undefined}
      data-keyboard-open={keyboardOpen ? '' : undefined}
      style={{
        ...(isMobile ? { position: 'fixed', left: 0, right: 0, top: vvTop } : {}),
        // On mobile, bind to visualViewport.height so the layout shrinks when
        // the soft keyboard opens; `100dvh` stays the full screen height and
        // would let the keyboard cover the terminal input.
        height: isMobile && vvHeight ? `${vvHeight}px` : '100dvh',
        paddingTop: 'env(safe-area-inset-top, 0px)',
        paddingBottom: keyboardOpen ? 0 : 'env(safe-area-inset-bottom, 0px)',
        paddingLeft: 'env(safe-area-inset-left, 0px)',
        paddingRight: 'env(safe-area-inset-right, 0px)',
      }}
    >
      {prelude}
      <div className="flex flex-1 min-h-0">
        {!isMobile && sidebarVisible && sidebar}
        {isMobile && (
          <MobileDrawer open={mobileDrawerOpen} onClose={onMobileDrawerClose}>
            {sidebar}
          </MobileDrawer>
        )}
        <main className="x-app-main flex-1 flex flex-col min-w-0 min-h-0">
          {isMobile ? mobileHeader : header}
          <div className="ive-main-body flex-1 flex flex-col min-h-0 min-w-0 relative">
            {children}
          </div>
          {!isMobile && footer}
          {!isMobile && <TerminalKeepAlive />}
        </main>
        {sideChat}
      </div>
      {overlays}
    </div>
  )
}
