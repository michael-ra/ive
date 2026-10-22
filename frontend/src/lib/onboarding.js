export const TOUR_VERSION = 2
const OWNER_KINDS = new Set(['owner_legacy', 'owner_device', 'localhost'])
export const tourStorageKey = (owner) => `ive.onboarding.v${TOUR_VERSION}.${owner ? 'owner' : 'guest'}`

function hasLocalCompletion(storage, owner) {
  try { return storage?.getItem(tourStorageKey(owner)) === 'done' } catch { return false }
}

export async function loadOnboarding({ request, storage, signal }) {
  const me = await request('/whoami', { signal })
  const owner = OWNER_KINDS.has(me?.actor_kind)
  if (!owner) return {
    profile: { owner: false, name: '', known: Boolean(me?.actor_kind) },
    shouldShow: Boolean(me?.actor_kind) && !hasLocalCompletion(storage, false),
  }
  const [tour, name] = await Promise.allSettled([
    request('/settings/product_tour_version', { signal }),
    request('/settings/owner_name', { signal }),
  ])
  const ownerName = name.status === 'fulfilled' ? name.value?.value || '' : ''
  const completed = tour.status === 'fulfilled' && Number(tour.value?.value) >= TOUR_VERSION
  return {
    profile: { owner: true, name: ownerName, known: true },
    shouldShow: !completed && !hasLocalCompletion(storage, true),
  }
}

export async function completeOnboarding({ profile, name = '', skip = false, localOnly = false, request, storage, onNameSaved }) {
  const save = (key, value) => request(`/settings/${key}`, {
    method: 'PUT', body: JSON.stringify({ value }), signal: AbortSignal.timeout(8000),
  })
  if (profile.owner && !localOnly) {
    if (!skip && name.trim() && name.trim() !== profile.name) {
      await save('owner_name', name.trim())
      onNameSaved?.(name.trim())
    }
    // Preserve the original name-onboarding marker. Only mark the new guide
    // complete after earlier writes succeed, so retry remains possible.
    await save('owner_intro_completed_at', new Date().toISOString())
    await save('product_tour_version', String(TOUR_VERSION))
  }
  try { storage?.setItem(tourStorageKey(profile.owner), 'done') } catch { /* Storage is optional. */ }
}
