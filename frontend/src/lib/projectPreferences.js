import { useSyncExternalStore } from 'react'
import useStore from '../state/store'
const KEY='ive-project-preferences-v1'
function read(){try {const p=JSON.parse(localStorage.getItem(KEY)||'{}');return {pinned:Array.isArray(p.pinned)?p.pinned:[],sort:p.sort==='manual'?'manual':'recent'}}catch{return {pinned:[],sort:'recent'}}}
let state=read()
const listeners=new Set()
export function setProjectPreference(patch){
 const next={...state,...patch}
 try { localStorage.setItem(KEY,JSON.stringify(next));state=next;listeners.forEach(f=>f());return true }
 catch {useStore.getState().addNotification({type:'warning',message:'Project preferences could not be saved on this device.'});return false}
}
window.addEventListener('storage',e=>{if(e.key===KEY){state=read();listeners.forEach(f=>f())}})
export const useProjectPreferences=()=>useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>state)
