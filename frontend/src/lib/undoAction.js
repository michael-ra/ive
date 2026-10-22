import useStore from '../state/store'
export function offerUndo(message, undo) {
  let busy = false
  useStore.getState().addNotification({type:'success',message,action:{label:'Undo',onClick:async()=>{
    if (busy) return false
    busy=true
    try { await undo(); return true }
    catch (error) { useStore.getState().addNotification({type:'warning',message:`Could not undo: ${error.message}. You can try again.`});return false }
    finally { busy=false }
  }}})
}
