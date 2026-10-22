// Web Push helpers — opt-in subscribe, graceful fallback when the
// server hasn't generated VAPID keys or the browser refuses Push.

import { api } from './api'

const STORAGE_KEY = 'cc-push-endpoint-v1'

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const arr = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
  return arr
}

export function isPushSupported() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

export async function getPushSubscription() {
  if (!isPushSupported()) return null
  const reg = await navigator.serviceWorker.getRegistration()
  if (!reg) return null
  return reg.pushManager.getSubscription()
}

export async function subscribeForPush() {
  if (!isPushSupported()) {
    return { ok: false, reason: 'unsupported' }
  }
  const reg = await navigator.serviceWorker.getRegistration()
  if (!reg) {
    return { ok: false, reason: 'no_service_worker' }
  }

  let permission = Notification.permission
  if (permission === 'default') {
    permission = await Notification.requestPermission()
  }
  if (permission !== 'granted') {
    return { ok: false, reason: 'permission_denied' }
  }

  const pk = await api.pushVapidPubkey()
  if (!pk?.public_key) {
    return { ok: false, reason: 'vapid_unconfigured' }
  }

  let sub = await reg.pushManager.getSubscription()
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(pk.public_key),
    })
  }

  const json = sub.toJSON()
  await api.subscribePush(json)
  try {
    localStorage.setItem(STORAGE_KEY, json.endpoint)
  } catch {}
  return { ok: true, subscription: json }
}

export async function unsubscribeFromPush() {
  const sub = await getPushSubscription()
  if (!sub) return { ok: true, removed: false }
  const endpoint = sub.endpoint
  try {
    await sub.unsubscribe()
  } catch {}
  try {
    await api.unsubscribePush(endpoint)
  } catch {}
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {}
  return { ok: true, removed: true }
}
