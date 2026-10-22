import GraphRenderer from './GraphRenderer'
import { isExtensionAvailable, resolveExtensionPanel } from '../../lib/extensionRegistry'

const CatalogGraph = resolveExtensionPanel('forge', 'CatalogGraph')

// Supplied graphs are an IVE primitive; only workspace graph discovery requires
// a product. Existing callers retain their props and lazy catalogue behavior.
export default function SystemGraph(props) {
  if (props.graph) return <GraphRenderer {...props} />
  if (isExtensionAvailable('forge')) return <CatalogGraph {...props} />
  return <div role="status" className="p-4 text-[12px] text-x-muted">Workspace code graphs require the Forge extension. Supplied graphs remain available.</div>
}
