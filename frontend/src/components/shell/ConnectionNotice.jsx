import useStore from '../../state/store'
import { useT } from '../../lib/i18n'
import '../../lib/i18n/shell'

// 28 px footer, only while the WebSocket is down. The sidebar foot shows the
// same state permanently; this line exists for a hidden sidebar.
export default function ConnectionNotice() {
  const connected = useStore((s) => s.connected)
  const t = useT()
  if (connected) return null
  return (
    <div role="status" className="ive-connection-notice" data-connection-notice="">
      <span className="ive-dot" data-state="waiting" aria-hidden="true" />
      {t('foot.reconnectingLong')}
    </div>
  )
}
