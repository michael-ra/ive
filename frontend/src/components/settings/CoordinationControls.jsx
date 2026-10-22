import { Brain, MessageSquare, Shield } from 'lucide-react'
import { Button } from '../ui'

// These host flags expose plain peer messaging, provider context and manual
// file claims. Optional products may extend their enabled capability groups.
export default function CoordinationControls({ workspace: ws, form, updateField, Field }) {
  return (
    <>
                      <Field label="Peer Communication" hint="Workers post/read messages on a shared bulletin board">
                        <Button
                          onClick={() => updateField(ws.id, 'comms_enabled', form.comms_enabled ? 0 : 1)}
                          toggleState={Boolean(form.comms_enabled)}
                          shape="card"
                          className="min-h-10 w-full justify-start py-2 text-left"
                          aria-label="Toggle peer communication"
                        >
                          <MessageSquare size={12} />
                          <span>{form.comms_enabled ? 'Enabled' : 'Disabled'}</span>
                          <span className="flex-1" />
                          <span className="text-[11px] text-x-ink-secondary">
                            {form.comms_enabled ? 'Workers can message each other' : 'No peer messaging'}
                          </span>
                        </Button>
                      </Field>

                      <Field label="Shared workspace context" hint="Expose available context providers to worker sessions">
                        <Button
                          onClick={() => updateField(ws.id, 'context_sharing_enabled', form.context_sharing_enabled ? 0 : 1)}
                          toggleState={Boolean(form.context_sharing_enabled)}
                          shape="card"
                          className="min-h-10 w-full justify-start py-2 text-left"
                          aria-label="Toggle shared context"
                        >
                          <Brain size={12} />
                          <span>{form.context_sharing_enabled ? 'Enabled' : 'Disabled'}</span>
                          <span className="flex-1" />
                          <span className="text-[11px] text-x-ink-secondary">{form.context_sharing_enabled ? 'Available providers shared with workers' : 'No shared-context tools'}</span>
                        </Button>
                      </Field>

                      <Field label="File coordination" hint="Manual file claims and available conflict checks">
                        <Button
                          onClick={() => updateField(ws.id, 'coordination_enabled', form.coordination_enabled ? 0 : 1)}
                          toggleState={Boolean(form.coordination_enabled)}
                          shape="card"
                          className="min-h-10 w-full justify-start py-2 text-left"
                          aria-label="Toggle file coordination"
                        >
                          <Shield size={12} />
                          <span>{form.coordination_enabled ? 'Enabled' : 'Disabled'}</span>
                          <span className="flex-1" />
                          <span className="text-[11px] text-x-ink-secondary">{form.coordination_enabled ? 'Workers can claim files' : 'Manual file-claim tools disabled'}</span>
                        </Button>
                      </Field>


    </>
  )
}
