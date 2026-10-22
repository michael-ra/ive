import useStore from '../state/store'
import HeaderPortal from '../components/shell/HeaderPortal'
import SessionGrid from '../components/overview/SessionGrid'
import GridToolbar from '../components/overview/GridToolbar'

// Scaffold stub: the Board level shows the tile wall. The board agent reads
// `overviewMode` ('board' | 'grid') and adds the Running / Waiting / Done
// columns; until then the grid renders in both modes.
export default function BoardScreen({ onOpenSession, onOpenPanel }) {
  const overviewMode = useStore((s) => s.overviewMode)
  void onOpenSession
  void onOpenPanel
  return (
    <div className="ive-board-screen flex-1 flex min-h-0 min-w-0 relative" data-board-screen="" data-overview-mode={overviewMode}>
      <HeaderPortal slot="actions"><GridToolbar /></HeaderPortal>
      <SessionGrid />
    </div>
  )
}
