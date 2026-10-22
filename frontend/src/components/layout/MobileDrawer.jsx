import { useEffect } from 'react'

/**
 * MobileDrawer — slide-in left drawer for mobile sidebar.
 *
 * Renders a full-height panel from the left edge with a scrim backdrop. The
 * drawer takes ~85vw (max 320px) so part of the underlying terminal stays
 * visible, signalling that the drawer is dismissable.
 *
 * Accessibility: Escape closes; backdrop click closes; body scroll locked
 * while open.
 *
 * Animation: pure CSS transform on a wrapper div. No external dependency.
 */
export default function MobileDrawer({ open, onClose, children }) {
  // Body scroll lock while open
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  // Escape to close
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <>
      {/* Backdrop scrim */}
      <div
        onClick={onClose}
        aria-hidden="true"
        className={`fixed inset-0 z-40 bg-x-scrim backdrop-blur-[4px] transition-opacity duration-[180ms] ease-x md:hidden ${
          open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
      />
      {/* Slide-in panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Sidebar"
        aria-hidden={open ? undefined : true}
        inert={!open}
        // Closed: invisible as well as off screen, so its shadow does not leave
        // a stripe along the left edge and its controls are out of the tab order.
        className={`fixed top-0 left-0 bottom-0 z-50 w-[85vw] max-w-[320px] bg-x-surface border-r border-x-line flex flex-col shadow-x-3 transition-[transform,visibility] duration-[180ms] ease-x md:hidden ${
          open ? 'translate-x-0 visible' : '-translate-x-full invisible'
        }`}
        style={{
          paddingTop: 'env(safe-area-inset-top, 0px)',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          paddingLeft: 'env(safe-area-inset-left, 0px)',
        }}
      >
        {children}
      </div>
    </>
  )
}
