import { forwardRef, useImperativeHandle } from 'react'
import GraphRenderer from './GraphRenderer'
import { isExtensionAvailable, resolveExtensionPanel } from '../../lib/extensionRegistry'
import { Button } from '../ui'

const CodeChangesCanvas = resolveExtensionPanel('forge', 'WorkspaceChangesCanvas')

const SuppliedGraphCanvas = forwardRef(function SuppliedGraphCanvas(props, ref) {
  useImperativeHandle(ref, () => ({ requestClose: (close = props.onClose) => {
    if (typeof close !== 'function') return false
    close()
    return true
  } }), [props.onClose])
  if (props.graph) return <GraphRenderer {...props} />
  return <div role="status" className="p-4 text-[12px] text-x-muted">
    Code changes and coverage graphs require the Forge extension. Ordinary file review remains available in IVE.
    {props.onClose && <Button onClick={props.onClose}>Close</Button>}
  </div>
})

export default forwardRef(function WorkspaceChangesCanvas(props, ref) {
  return isExtensionAvailable('forge') && !props.graph
    ? <CodeChangesCanvas {...props} hostRef={ref} />
    : <SuppliedGraphCanvas {...props} ref={ref} />
})
