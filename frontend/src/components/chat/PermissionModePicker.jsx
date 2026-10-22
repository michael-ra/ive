import { useEffect } from 'react'
import { Shield } from 'lucide-react'
import useStore from '../../state/store'
import { getPermissionModesForCli } from '../../lib/constants'
import { changePermissionMode, applyPermissionModeNow, refreshPermissionMode } from '../../lib/permissionMode'
import LaunchSettingPicker from './LaunchSettingPicker'

/** One control and one apply path for Overview and Terminal. */
export default function PermissionModePicker({ sessionId, testId = 'perms' }) {
  const session = useStore(s => s.sessions[sessionId])
  const info = useStore(s => s.permissionApply[sessionId])
  const profiles = useStore(s => s.cliProfiles)
  useEffect(() => {
    refreshPermissionMode(sessionId).catch(() => {})
  }, [sessionId])
  const modes = getPermissionModesForCli(session?.cli_type || 'claude')
  if (!session || !modes.length || session.read_only) return null
  const options = modes.map(mode => ({ value: mode.id, label: mode.label, short: mode.label, description: mode.description }))
  const label = value => options.find(mode => mode.value === value)?.label || value || 'Default'
  const configured = session.permission_mode || modes[0].id
  const current = info?.from ?? configured
  const failed = info?.state === 'failed'
  const waiting = session.status === 'waiting' || session.agentState === 'waiting'
  return <LaunchSettingPicker
    testId={testId} sessionId={sessionId} icon={<Shield size={11} className="text-x-muted" />}
    label="Agent mode:" displayValue={failed ? 'Change failed' : label(current)}
    title="Shared with Terminal and Overview. A mode change restarts the agent and resumes this conversation."
    options={options} selected={current}
    apply={info ? { ...info, value: info.mode ?? info.value } : null}
    onSelect={mode => changePermissionMode(sessionId, mode)}
    onApplyNow={() => applyPermissionModeNow(sessionId)}
    showCurrent width="w-80"
    pendingText={waiting ? 'Answer the current request first, or interrupt and apply the new mode.' : 'The new mode applies after the current answer.'}
    applyNowLabel="Interrupt & apply"
    footer={<>
      <div>Shared by Overview and Terminal.</div>
      {session.pty_alive === false && <div>The selected mode is used on the next start.</div>}
      <div className="mt-1">Additional IVE checks remain separate. Skipping agent approvals does not disable them.</div>
    </>}
  />
}
