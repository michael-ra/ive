import { useEffect, useRef } from 'react'
import { Trash2 } from 'lucide-react'
import { Modal, Button } from '../ui'
import { useSessionDelete, cancelSessionDeletion, confirmSessionDeletion } from '../../lib/sessionActions'

function DeleteConfirmation({ request }) {
  const defaultRef = useRef(null)
  const project = request.kind === 'workspace'
  useEffect(() => { defaultRef.current?.focus() }, [])
  return (
    <Modal size="sm" title={project ? 'Remove project?' : 'Delete session?'} icon={Trash2}
      onClose={request.pending ? undefined : cancelSessionDeletion}
      bodyClassName="p-5 gap-3" className="!h-auto"
      footer={<div className="flex justify-end gap-2">
        <Button ref={project ? defaultRef : undefined} onClick={cancelSessionDeletion} disabled={request.pending} className="min-h-11">Cancel</Button>
        <Button ref={project ? undefined : defaultRef} variant="destructive" icon={Trash2} loading={request.pending} disabled={request.pending}
          onClick={confirmSessionDeletion} className="min-h-11 border-x-danger/30 bg-x-danger/10">
          {request.pending ? (project ? 'Removing…' : 'Deleting…') : (project ? 'Remove project' : 'Delete session')}
        </Button>
      </div>}>
      {project ? <>
        <p className="text-sm text-x-ink break-words">Remove <strong>{request.name}</strong> from IVE? Its sessions will be stopped, and their chat history and saved project data will be deleted.</p>
        {request.path && <p className="rounded-md bg-x-surface-2 px-3 py-2 text-xs font-mono text-x-muted break-words">{request.path}</p>}
        <p className="text-sm text-x-muted">Your project folder and source files will stay on your computer. You can connect the folder again, but the deleted IVE history cannot be restored.</p>
      </> : <>
        <p className="text-sm text-x-ink break-words"><strong>{request.name}</strong> will be stopped and removed from IVE, including its chat history.</p>
        <p className="text-sm text-x-muted">This cannot be undone. Your project files will stay on your computer.</p>
      </>}
      {request.error && <p role="alert" className="rounded-lg border border-x-danger/30 bg-x-danger/10 p-3 text-sm text-x-danger break-words">{request.error}</p>}
    </Modal>
  )
}

export default function SessionDeleteDialog() {
  const request = useSessionDelete((state) => state.request)
  useEffect(() => () => cancelSessionDeletion(), [])
  return request ? <DeleteConfirmation key={`${request.kind}:${request.id}`} request={request} /> : null
}
