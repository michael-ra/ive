import useStore from '../state/store'
import { viewOf } from '../lib/route'

// The one answer to "where am I?": 'home' | 'board' | 'session'. Replaces
// useViewLevel from components/navigation/ViewSwitch.jsx. The selector
// returns a string, so the component re-renders only when the level changes.
export default function useView() {
  return useStore(viewOf)
}
