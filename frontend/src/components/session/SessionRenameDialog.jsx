import { useEffect, useId, useRef, useState } from 'react'
import { Pencil } from 'lucide-react'
import { Modal, Button, Field, Input } from '../ui'
import { useSessionRename, cancelSessionRename, saveSessionRename } from '../../lib/sessionRename'

function RenameEditor({ request }) {
  const [value, setValue] = useState(request.name)
  const inputRef = useRef(null)
  const formId = useId()
  const errorId = useId()
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select() }, [])

  return (
    <Modal size="sm" title="Rename session" icon={Pencil}
      onClose={request.pending ? undefined : cancelSessionRename}
      bodyClassName="p-5 gap-3" className="!h-auto"
      footer={<div className="flex justify-end gap-2">
        <Button onClick={cancelSessionRename} disabled={request.pending}>Cancel</Button>
        <Button type="submit" form={formId} variant="primary" loading={request.pending}
          disabled={request.pending || !value.trim()}>{request.pending ? 'Saving…' : 'Save'}</Button>
      </div>}>
      <form id={formId} className="flex flex-col gap-3" onSubmit={(event) => {
        event.preventDefault()
        saveSessionRename(value)
      }}>
        <Field label="Session name">
          <Input ref={inputRef} value={value} disabled={request.pending} required
            onChange={(event) => setValue(event.target.value)}
            aria-describedby={request.error ? errorId : undefined} />
        </Field>
        {request.error && <p id={errorId} role="alert" className="text-sm text-x-danger">{request.error}</p>}
      </form>
    </Modal>
  )
}

export default function SessionRenameDialog() {
  const request = useSessionRename((state) => state.request)
  return request ? <RenameEditor key={request.id} request={request} /> : null
}
