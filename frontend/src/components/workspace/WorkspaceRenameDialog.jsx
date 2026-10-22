import { useEffect, useId, useRef, useState } from 'react'
import { Pencil } from 'lucide-react'
import { Modal, Button, Field, Input } from '../ui'
import { api } from '../../lib/api'
import useStore from '../../state/store'

export default function WorkspaceRenameDialog({ workspace, onClose }) {
  const [name, setName] = useState(workspace.name || '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const input = useRef(null), formId = useId()
  useEffect(() => { input.current?.focus(); input.current?.select() }, [])
  const save = async event => {
    event.preventDefault()
    if (pending || !name.trim()) return
    setPending(true); setError('')
    try {
      const updated = await api.updateWorkspace(workspace.id, { name: name.trim() })
      useStore.getState().setWorkspaces(useStore.getState().workspaces.map(w => w.id === workspace.id ? { ...w, name: updated.name || name.trim() } : w))
      onClose()
    } catch (e) { setError(e.message || 'Could not rename this project.'); setPending(false) }
  }
  return <Modal size="sm" title="Rename project" icon={Pencil} onClose={pending ? undefined : onClose} bodyClassName="p-5 gap-3" className="!h-auto"
    footer={<div className="flex justify-end gap-2"><Button onClick={onClose} disabled={pending}>Cancel</Button><Button type="submit" form={formId} variant="primary" disabled={pending || !name.trim()} loading={pending}>Save</Button></div>}>
    <form id={formId} onSubmit={save} className="flex flex-col gap-3">
      <Field label="Project name"><Input ref={input} value={name} onChange={e => setName(e.target.value)} maxLength={120} required disabled={pending} /></Field>
      <p className="text-xs text-x-muted">Changes the name in IVE. Your project folder stays where it is.</p>
      {error && <p role="alert" className="text-sm text-x-danger">{error}</p>}
    </form>
  </Modal>
}
