import { useCallback, useEffect, useRef, useState } from 'react'
import { request } from '../lib/api'
import useStore from '../state/store'
import { completeOnboarding, loadOnboarding } from '../lib/onboarding'
import { readTour, reduceTourEvent, writeTour } from '../lib/guidedTour'

function browserStorage() {
  try { return window.localStorage } catch { return null }
}

export default function useOnboarding() {
  const [open, setOpen] = useState(false)
  const [profile, setProfile] = useState({ owner: false, name: '', known: false })
  const dismissed = useRef(false)

  useEffect(() => {
    // A context submission belongs to the user's session, even when its
    // coach was paused while the server was confirming receipt. Preserve
    // that receipt so resuming never asks the user to send it twice.
    const receive = ({ detail }) => {
      if (!['context-sent', 'context-failed'].includes(detail?.type)) return
      const progress = readTour(browserStorage(), profile.owner)
      if (!progress.paused || !progress.contextSending) return
      const next = reduceTourEvent({ ...progress, paused: false }, detail)
      writeTour(browserStorage(), profile.owner, { ...next, paused: true })
    }
    window.addEventListener('ive-tour-event', receive)
    return () => window.removeEventListener('ive-tour-event', receive)
  }, [profile.owner])

  useEffect(() => {
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8000)])
    let cancelled = false
    ;(async () => {
      try {
        const { profile: loadedProfile, shouldShow } = await loadOnboarding({ request, storage: browserStorage(), signal })
        if (cancelled) return
        setProfile(loadedProfile)
        if (loadedProfile.name) useStore.getState().setMyName?.(loadedProfile.name)
        const progress = readTour(browserStorage(), loadedProfile.owner)
        if (shouldShow && !progress.paused && !dismissed.current) setOpen(true)
      } catch { /* An unavailable login must not interrupt the application. Help stays available. */ }
    })()
    return () => { cancelled = true; controller.abort() }
  }, [])

  const finish = useCallback(async ({ name = '', skip = false, localOnly = false } = {}) => {
    await completeOnboarding({
      profile, name, skip, localOnly, request, storage: browserStorage(),
      onNameSaved: (savedName) => {
        useStore.getState().setMyName?.(savedName)
        setProfile((previous) => ({ ...previous, name: savedName }))
      },
    })
    dismissed.current = true
    setOpen(false)
  }, [profile])

  const show = useCallback(() => setOpen(true), [])
  const pause = useCallback(() => { dismissed.current = true; setOpen(false) }, [])
  return { open, profile, finish, show, pause }
}
