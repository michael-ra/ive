import { useEffect, useState } from 'react'

/**
 * useMediaQuery — subscribe to a CSS media query and re-render on match changes.
 *
 * Usage:
 *   const isMobile = useMediaQuery('(max-width: 767px)')
 *
 * SSR-safe (returns false when window is undefined).
 */
export default function useMediaQuery(query) {
  const get = () => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia(query).matches
  }

  const [matches, setMatches] = useState(get)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia(query)
    const handler = (e) => setMatches(e.matches)
    // Set immediately in case the value changed between mount and effect
    setMatches(mql.matches)
    if (mql.addEventListener) mql.addEventListener('change', handler)
    else mql.addListener(handler) // older Safari fallback
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', handler)
      else mql.removeListener(handler)
    }
  }, [query])

  return matches
}
