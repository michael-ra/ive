import HelpDetails from '../ui/HelpDetails'
import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, Check, Cpu, Eye, KeyRound, Plus, RefreshCw, Save, Terminal, Trash2,
} from 'lucide-react'
import { api } from '../../lib/api'
import { Button, EmptyState, Field, IconButton, Input, Modal, StatusBar, Textarea } from '../ui'

const KINDS = [
  ['gemini_api', 'Gemini API'],
  ['openai_compatible', 'OpenAI compatible'],
  ['ollama', 'Ollama'],
  ['cli', 'CLI subscription profile'],
]

const EMPTY_FORM = {
  id: '',
  kind: 'openai_compatible',
  base_url: '',
  models: '',
  fallback: '',
  capabilities: 'json',
  timeout_ms: '1500',
  enabled: false,
}

const EMPTY_CLI_FORM = {
  id: '',
  label: '',
  binary: '',
  binary_candidates: '',
  oneshot_args: 'run',
  prompt_mode: 'arg',
  model_flag: '--model',
  config_dir_env: '',
  config_dir_subpath: '',
  home_dir: '',
  settings_file: '',
  hook_settings_file: '',
  mcp_config_file: '',
  plugin_cache_dir: '',
  auth_dir_name: '',
  default_model: 'default',
  available_models: 'default',
  hook_event_map: '{}',
  default_hook_events: '',
  hook_config_format: 'json',
  session_file_pattern: '*.jsonl',
  mcp_strategy: 'config_file',
}

function splitValues(value) {
  return value.split(/[\n,]/).map(item => item.trim()).filter(Boolean)
}

function registryEntry(provider) {
  return {
    id: provider.id,
    kind: provider.kind,
    base_url: provider.base_url,
    api_key_setting: provider.api_key_setting,
    models: provider.models,
    fallback: provider.fallback,
    capabilities: provider.capabilities,
    timeout_ms: provider.timeout_ms,
    enabled: provider.enabled,
  }
}

function formFor(provider) {
  return {
    id: provider.id,
    kind: provider.kind,
    base_url: provider.base_url,
    models: provider.models.join(', '),
    fallback: provider.fallback.join(', '),
    capabilities: provider.capabilities.join(', '),
    timeout_ms: String(provider.timeout_ms),
    enabled: provider.enabled,
  }
}

export default function ModelProvidersPanel() {
  const [data, setData] = useState({ providers: [], health: [] })
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [keyValue, setKeyValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const [cliModalOpen, setCliModalOpen] = useState(false)
  const [cliForm, setCliForm] = useState(EMPTY_CLI_FORM)
  const [hookPreview, setHookPreview] = useState(null)
  const [hookConfirmed, setHookConfirmed] = useState(false)
  const [savedCliProfileId, setSavedCliProfileId] = useState(null)

  useEffect(() => {
    let active = true
    setBusy(true)
    api.getModelProviders()
      .then((next) => { if (active) setData(next) })
      .catch((error) => {
        if (active) setMessage({ error: true, text: error.message || 'Could not load providers' })
      })
      .finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [])

  const healthById = useMemo(
    () => new Map((data.health || []).map(item => [item.id, item])),
    [data.health],
  )

  const publish = (next) => {
    setData(next)
  }

  const reload = async () => {
    const next = await api.getModelProviders()
    publish(next)
    return next
  }

  const refresh = async () => {
    setBusy(true)
    setMessage(null)
    try {
      await reload()
    } catch (error) {
      setMessage({ error: true, text: error.message || 'Could not load providers' })
    }
    setBusy(false)
  }

  const saveRegistry = async (providers, successText) => {
    setBusy(true)
    setMessage(null)
    try {
      await api.setModelProviders(providers.map(registryEntry))
      await reload()
      setMessage({ error: false, text: successText })
      return true
    } catch (error) {
      setMessage({ error: true, text: error.message || 'Could not save providers' })
      return false
    } finally {
      setBusy(false)
    }
  }

  const beginAdd = () => {
    setEditingId('__new__')
    setForm(EMPTY_FORM)
    setKeyValue('')
    setMessage(null)
  }

  const beginEdit = (provider) => {
    setEditingId(provider.id)
    setForm(formFor(provider))
    setKeyValue('')
    setMessage(null)
  }

  const beginAddCli = () => {
    setCliForm(EMPTY_CLI_FORM)
    setHookPreview(null)
    setHookConfirmed(false)
    setSavedCliProfileId(null)
    setMessage(null)
    setCliModalOpen(true)
  }

  const setCliField = (field, value) => {
    setCliForm(current => ({ ...current, [field]: value }))
  }

  const declarativeProfilePayload = () => {
    let hookEventMap
    try {
      hookEventMap = JSON.parse(cliForm.hook_event_map)
    } catch {
      throw new Error('Hook event map must be valid JSON')
    }
    const modelIds = splitValues(cliForm.available_models)
    return {
      id: cliForm.id.trim().toLowerCase(),
      label: cliForm.label.trim(),
      binary: cliForm.binary.trim(),
      binary_candidates: splitValues(cliForm.binary_candidates),
      oneshot_args: cliForm.oneshot_args.split('\n').map(item => item.trim()).filter(Boolean),
      prompt_mode: cliForm.prompt_mode,
      model_flag: cliForm.model_flag.trim(),
      config_dir_env: cliForm.config_dir_env.trim(),
      config_dir_subpath: cliForm.config_dir_subpath.trim(),
      hook_event_map: hookEventMap,
      default_hook_events: splitValues(cliForm.default_hook_events),
      hook_config_format: cliForm.hook_config_format,
      home_dir: cliForm.home_dir.trim(),
      settings_file: cliForm.settings_file.trim(),
      hook_settings_file: cliForm.hook_settings_file.trim(),
      mcp_config_file: cliForm.mcp_config_file.trim(),
      plugin_cache_dir: cliForm.plugin_cache_dir.trim(),
      auth_dir_name: cliForm.auth_dir_name.trim(),
      default_model: cliForm.default_model.trim(),
      available_models: modelIds.map(id => ({ id, label: id, description: '' })),
      session_file_pattern: cliForm.session_file_pattern.trim(),
      mcp_strategy: cliForm.mcp_strategy,
    }
  }

  const saveCliProfile = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const profile = declarativeProfilePayload()
      const created = await api.addCliProfile(profile)
      setSavedCliProfileId(profile.id)
      await reload()
      if (profile.default_hook_events.length > 0) {
        try {
          const preview = await api.dryRunCliProfileHooks(profile.id)
          setHookPreview(preview)
          setHookConfirmed(false)
        } catch (error) {
          setMessage({
            error: true,
            text: `Profile saved, but the hook dry run was refused: ${error.message}`,
          })
          return
        }
      } else {
        setCliModalOpen(false)
      }
      setMessage({
        error: false,
        text: created.provider.enabled
          ? `CLI profile '${profile.id}' added`
          : `CLI profile '${profile.id}' added disabled because its binary was not found`,
      })
    } catch (error) {
      setMessage({ error: true, text: error.message || 'Could not add CLI profile' })
    } finally {
      setBusy(false)
    }
  }

  const previewSavedCliHooks = async () => {
    if (!savedCliProfileId) return
    setBusy(true)
    setMessage(null)
    try {
      const preview = await api.dryRunCliProfileHooks(savedCliProfileId)
      setHookPreview(preview)
      setHookConfirmed(false)
    } catch (error) {
      setMessage({ error: true, text: error.message || 'Hook dry run was refused' })
    } finally {
      setBusy(false)
    }
  }

  const installCliHooks = async () => {
    if (!hookPreview || !hookConfirmed) return
    setBusy(true)
    setMessage(null)
    try {
      await api.confirmCliProfileHooks(hookPreview.profile_id, hookPreview.confirmation)
      setCliModalOpen(false)
      setHookPreview(null)
      setMessage({ error: false, text: `Hooks installed in ${hookPreview.path}` })
    } catch (error) {
      setMessage({ error: true, text: error.message || 'Could not install CLI hooks' })
    } finally {
      setBusy(false)
    }
  }

  const saveForm = async () => {
    const id = form.id.trim().toLowerCase()
    const apiKind = ['gemini_api', 'openai_compatible'].includes(form.kind)
    const nextProvider = {
      id,
      kind: form.kind,
      base_url: form.kind === 'cli' ? '' : form.base_url.trim(),
      api_key_setting: apiKind ? `api_key_${id}` : '',
      models: form.models.split(/[\n,]/).map(item => item.trim()).filter(Boolean),
      fallback: form.fallback.split(/[\n,]/).map(item => item.trim()).filter(Boolean),
      capabilities: form.capabilities.split(/[\n,]/).map(item => item.trim()).filter(Boolean),
      timeout_ms: Number(form.timeout_ms),
      enabled: !!form.enabled,
    }
    const providers = data.providers.map(registryEntry)
    const existingIndex = providers.findIndex(item => item.id === editingId)
    if (existingIndex >= 0) providers[existingIndex] = nextProvider
    else providers.push(nextProvider)
    if (await saveRegistry(providers, `Provider '${id}' saved`)) {
      setEditingId(id)
    }
  }

  const toggleProvider = async (provider) => {
    const providers = data.providers.map(item => ({
      ...registryEntry(item),
      enabled: item.id === provider.id ? !item.enabled : item.enabled,
    }))
    await saveRegistry(
      providers,
      `Provider '${provider.id}' ${provider.enabled ? 'disabled' : 'enabled'}`,
    )
  }

  const saveKey = async (provider, value) => {
    setBusy(true)
    setMessage(null)
    try {
      await api.setModelProviderKey(provider.id, value)
      setKeyValue('')
      await reload()
      setMessage({
        error: false,
        text: value ? `Key for '${provider.id}' saved` : `Key for '${provider.id}' removed`,
      })
    } catch (error) {
      setMessage({ error: true, text: error.message || 'Could not save API key' })
    }
    setBusy(false)
  }

  const selected = data.providers.find(item => item.id === editingId)

  return (
    <div className="h-full overflow-y-auto p-4">
          <div className="space-y-3">
      <div className="flex items-start gap-3 rounded-md border border-x-line bg-x-surface p-3">
        <Cpu size={15} className="mt-0.5 shrink-0 text-x-accent" />
        <div>
          <p className="text-[12px] font-medium text-x-ink">Model providers</p>
          <HelpDetails label="How model routing works"><p className="mt-0.5 text-[11px] leading-relaxed text-x-ink-secondary">
            Every model is addressed as provider:model. Fallbacks are explicit provider chains,
            and capabilities are checked before dispatch.
          </p></HelpDetails>
        </div>
        <IconButton
          icon={RefreshCw}
          label="Refresh provider reachability"
          onClick={refresh}
          disabled={busy}
          className={`ml-auto ${busy ? 'animate-spin' : ''}`}
        />
      </div>

      <div className="grid grid-cols-[240px_1fr] gap-3">
        <div className="space-y-1.5">
          {(data.providers || []).map(provider => {
            const health = healthById.get(provider.id)
            const reachable = health?.reachable
            return (
              <div key={provider.id} className="relative">
                <button
                  type="button"
                  data-provider-row={provider.id}
                  onClick={() => beginEdit(provider)}
                  className={`min-h-[54px] w-full min-w-0 rounded-xl border py-2 pl-2.5 pr-[86px] text-left transition-colors duration-[80ms] ${
                    editingId === provider.id
                      ? 'border-x-accent bg-x-accent/10'
                      : 'border-x-line bg-x-surface hover:bg-x-hover'
                  }`}
                >
                  <span className="flex items-center gap-1.5 text-[12px] font-medium text-x-ink">
                    <span className={`h-1.5 w-1.5 rounded-full ${
                      reachable ? 'bg-x-good' : provider.enabled ? 'bg-x-accent-ink' : 'bg-x-muted'
                    }`} />
                    {provider.id}
                  </span>
                  <span className={`mt-0.5 block break-words text-[11px] leading-snug ${
                    provider.enabled && !reachable ? 'text-x-accent-ink' : 'text-x-muted'
                  }`}>
                    {!provider.enabled ? 'disabled' : health?.reason || provider.kind}
                    {provider.cli_profile ? ` · ${provider.cli_profile.isolation}` : ''}
                  </span>
                </button>
                <Button
                  onClick={() => toggleProvider(provider)}
                  disabled={busy}
                  size="sm"
                  toggleState={provider.enabled}
                  className="absolute right-2 top-1/2 min-w-[72px] -translate-y-1/2 px-2"
                  aria-label={`${provider.enabled ? 'Disable' : 'Enable'} ${provider.id} provider`}
                  title={provider.enabled ? 'Disable provider' : 'Enable provider'}
                >
                  {provider.enabled ? 'On' : 'Off'}
                </Button>
              </div>
            )
          })}
          <Button
            icon={Plus}
            onClick={beginAdd}
            className="w-full"
          >
            Add provider
          </Button>
          <Button
            icon={Terminal}
            onClick={beginAddCli}
            className="w-full"
          >
            Add a CLI profile
          </Button>
        </div>

        <div className="flex min-h-[360px] rounded-xl border border-x-line bg-x-surface p-3">
          {editingId ? (
            <div className="w-full space-y-2.5">
              <div className="grid grid-cols-2 gap-2">
                <label className="text-[11px] text-x-ink-secondary">
                  Provider id
                  <input
                    value={form.id}
                    disabled={editingId !== '__new__'}
                    onChange={event => setForm({ ...form, id: event.target.value })}
                    className="mt-1 h-8 w-full rounded-md border border-x-line bg-x-surface-2 px-2 text-[12px] text-x-ink disabled:opacity-60"
                  />
                </label>
                <label className="text-[11px] text-x-ink-secondary">
                  Kind
                  <select
                    value={form.kind}
                    onChange={event => setForm({ ...form, kind: event.target.value })}
                    className="mt-1 h-8 w-full rounded-md border border-x-line bg-x-surface-2 px-2 text-[12px] text-x-ink"
                  >
                    {KINDS.map(([id, label]) => (
                      <option key={id} value={id} disabled={editingId === '__new__' && id === 'cli'}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {form.kind !== 'cli' && (
                <label className="block text-[11px] text-x-ink-secondary">
                  Base URL
                  <input
                    value={form.base_url}
                    onChange={event => setForm({ ...form, base_url: event.target.value })}
                    className="mt-1 h-8 w-full rounded-md border border-x-line bg-x-surface-2 px-2 font-mono text-[11px] text-x-ink"
                  />
                </label>
              )}
              <label className="block text-[11px] text-x-ink-secondary">
                Models <span className="text-x-faint">(comma separated)</span>
                <input
                  value={form.models}
                  onChange={event => setForm({ ...form, models: event.target.value })}
                  className="mt-1 h-8 w-full rounded-md border border-x-line bg-x-surface-2 px-2 font-mono text-[11px] text-x-ink"
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-[11px] text-x-ink-secondary">
                  Fallback providers <span className="text-x-faint">(in order)</span>
                  <input
                    value={form.fallback}
                    placeholder="gemini, claude"
                    onChange={event => setForm({ ...form, fallback: event.target.value })}
                    className="mt-1 h-8 w-full rounded-md border border-x-line bg-x-surface-2 px-2 font-mono text-[11px] text-x-ink"
                  />
                </label>
                <label className="text-[11px] text-x-ink-secondary">
                  Capabilities <span className="text-x-faint">(json, vision)</span>
                  <input
                    value={form.capabilities}
                    onChange={event => setForm({ ...form, capabilities: event.target.value })}
                    className="mt-1 h-8 w-full rounded-md border border-x-line bg-x-surface-2 px-2 font-mono text-[11px] text-x-ink"
                  />
                </label>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-[11px] text-x-ink-secondary">
                  Timeout (ms)
                  <input
                    type="number"
                    min="100"
                    max="300000"
                    value={form.timeout_ms}
                    onChange={event => setForm({ ...form, timeout_ms: event.target.value })}
                    className="mt-1 h-8 w-full rounded-md border border-x-line bg-x-surface-2 px-2 text-[12px] text-x-ink"
                  />
                </label>
                <div className="mt-5 flex h-8 items-center justify-between gap-2 text-[11px] text-x-ink-secondary">
                  <span>Provider status</span>
                  <Button
                    type="button"
                    toggleState={form.enabled}
                    shape="card"
                    size="sm"
                    onClick={() => setForm({ ...form, enabled: !form.enabled })}
                  >
                    {form.enabled ? 'Enabled' : 'Disabled'}
                  </Button>
                </div>
              </div>
              <Button
                icon={Save}
                onClick={saveForm}
                disabled={busy}
                variant="primary"
                size="sm"
              >
                Save provider
              </Button>

              {selected?.api_key_setting && (
                <div className="border-t border-x-line pt-2.5">
                  <label className="text-[11px] text-x-ink-secondary">
                    <span className="flex items-center gap-1"><KeyRound size={11} /> API key</span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={keyValue}
                      placeholder={selected.api_key_masked || selected.api_key_setting}
                      onChange={event => setKeyValue(event.target.value)}
                      className="mt-1 h-8 w-full rounded-md border border-x-line bg-x-surface-2 px-2 font-mono text-[11px] text-x-ink"
                    />
                  </label>
                  <div className="mt-2 flex gap-2">
                    <Button
                      onClick={() => saveKey(selected, keyValue)}
                      disabled={busy || !keyValue}
                      variant="primary"
                      size="sm"
                    >
                      Save key
                    </Button>
                    {selected.api_key_configured && (
                      <Button
                        icon={Trash2}
                        onClick={() => saveKey(selected, '')}
                        disabled={busy}
                        variant="destructive"
                        size="sm"
                      >
                        Remove key
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <EmptyState
              icon={Cpu}
              title="Choose a model provider"
              description="Select a provider from the list."
            />
          )}
        </div>
      </div>

      <Modal
        open={cliModalOpen}
        onClose={() => { if (!busy) setCliModalOpen(false) }}
        icon={hookPreview ? Eye : Terminal}
        title={hookPreview ? 'Review CLI hook changes' : 'Add a CLI profile'}
        subtitle={hookPreview
          ? 'Dry run only — the foreign settings file is still untouched'
          : 'Create a strict data adapter; no Python is required'}
        size="lg"
        bodyClassName="overflow-hidden"
        footer={(
          <div className="flex items-center justify-end gap-2">
            <Button onClick={() => setCliModalOpen(false)} disabled={busy}>
              {hookPreview || savedCliProfileId ? 'Keep profile without installing' : 'Cancel'}
            </Button>
            {hookPreview ? (
              <Button
                variant="primary"
                icon={Check}
                onClick={installCliHooks}
                disabled={busy || !hookConfirmed}
              >
                Confirm and write hooks
              </Button>
            ) : savedCliProfileId ? (
              <Button
                variant="primary"
                icon={Eye}
                onClick={previewSavedCliHooks}
                disabled={busy}
              >
                Retry dry run
              </Button>
            ) : (
              <Button
                variant="primary"
                icon={Save}
                onClick={saveCliProfile}
                disabled={busy}
              >
                Save profile and preview hooks
              </Button>
            )}
          </div>
        )}
      >
        {message && cliModalOpen && (
          <StatusBar tone={message.error ? 'error' : 'ok'}>{message.text}</StatusBar>
        )}
        {hookPreview ? (
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            <StatusBar tone="info" className="rounded-md border">
              Nothing has been written. This preview used {hookPreview.merge_path} and validated
              the complete {hookPreview.hook_config_format.toUpperCase()} result.
            </StatusBar>
            <Field label="Exact target path">
              <Input mono readOnly value={hookPreview.path} />
            </Field>
            <Field label="Exact hook content to add">
              <Textarea mono readOnly rows={10} value={hookPreview.hook_content} />
            </Field>
            <Field label="Complete merged file after confirmation">
              <Textarea mono readOnly rows={14} value={hookPreview.merged_content} />
            </Field>
            <label className="flex items-start gap-2 rounded-md border border-x-line bg-x-surface-2 p-3 text-[12px] text-x-ink-secondary">
              <input
                type="checkbox"
                checked={hookConfirmed}
                onChange={event => setHookConfirmed(event.target.checked)}
                className="mt-0.5"
              />
              I confirm this exact path and merged content may be written to the CLI's settings.
            </label>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-5 space-y-5">
            <section className="space-y-3">
              <h3 className="text-[12px] font-semibold text-x-ink">Command adapter</h3>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Profile id" hint="lowercase registry id">
                  <Input mono value={cliForm.id} onChange={event => setCliField('id', event.target.value)} />
                </Field>
                <Field label="Display label">
                  <Input value={cliForm.label} onChange={event => setCliField('label', event.target.value)} />
                </Field>
                <Field label="Binary">
                  <Input mono value={cliForm.binary} onChange={event => setCliField('binary', event.target.value)} />
                </Field>
                <Field label="Binary candidates" hint="comma or newline separated">
                  <Input mono value={cliForm.binary_candidates} onChange={event => setCliField('binary_candidates', event.target.value)} />
                </Field>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <Field label="One-shot argv" hint="one fixed token per line">
                  <Textarea mono rows={3} value={cliForm.oneshot_args} onChange={event => setCliField('oneshot_args', event.target.value)} />
                </Field>
                <Field label="Prompt mode">
                  <select
                    value={cliForm.prompt_mode}
                    onChange={event => setCliField('prompt_mode', event.target.value)}
                    className="h-8 rounded-md border border-x-line bg-x-surface-2 px-3 text-[12px] text-x-ink"
                  >
                    <option value="arg">Argument</option>
                    <option value="stdin">Standard input</option>
                  </select>
                </Field>
                <Field label="Model flag" hint="blank = one implicit model">
                  <Input mono value={cliForm.model_flag} onChange={event => setCliField('model_flag', event.target.value)} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Available model ids" hint="comma or newline separated">
                  <Input mono value={cliForm.available_models} onChange={event => setCliField('available_models', event.target.value)} />
                </Field>
                <Field label="Default model id">
                  <Input mono value={cliForm.default_model} onChange={event => setCliField('default_model', event.target.value)} />
                </Field>
              </div>
            </section>

            <section className="space-y-3 border-t border-x-line pt-4">
              <h3 className="text-[12px] font-semibold text-x-ink">Config and credential isolation</h3>
              {!cliForm.config_dir_env && (
                <StatusBar tone="warn" className="rounded-md border">
                  HOME-only isolation. No CLI-specific config environment variable will be guessed.
                </StatusBar>
              )}
              <div className="grid grid-cols-2 gap-3">
                <Field label="Config directory env" hint="verified CLI env variable only">
                  <Input mono value={cliForm.config_dir_env} onChange={event => setCliField('config_dir_env', event.target.value)} />
                </Field>
                <Field label="Config sub-path under account HOME">
                  <Input mono value={cliForm.config_dir_subpath} onChange={event => setCliField('config_dir_subpath', event.target.value)} />
                </Field>
                <Field label="Declared home directory">
                  <Input mono placeholder="~/.config/example" value={cliForm.home_dir} onChange={event => setCliField('home_dir', event.target.value)} />
                </Field>
                <Field label="Auth directory name">
                  <Input mono value={cliForm.auth_dir_name} onChange={event => setCliField('auth_dir_name', event.target.value)} />
                </Field>
              </div>
            </section>

            <section className="space-y-3 border-t border-x-line pt-4">
              <h3 className="text-[12px] font-semibold text-x-ink">Settings, hooks, and sessions</h3>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Settings file">
                  <Input mono value={cliForm.settings_file} onChange={event => setCliField('settings_file', event.target.value)} />
                </Field>
                <Field label="Hook settings override" hint="blank uses settings file">
                  <Input mono value={cliForm.hook_settings_file} onChange={event => setCliField('hook_settings_file', event.target.value)} />
                </Field>
                <Field label="MCP config file" hint="optional">
                  <Input mono value={cliForm.mcp_config_file} onChange={event => setCliField('mcp_config_file', event.target.value)} />
                </Field>
                <Field label="Plugin cache directory" hint="required; must stay inside declared home">
                  <Input mono value={cliForm.plugin_cache_dir} onChange={event => setCliField('plugin_cache_dir', event.target.value)} />
                </Field>
                <Field label="Session file pattern">
                  <Input mono value={cliForm.session_file_pattern} onChange={event => setCliField('session_file_pattern', event.target.value)} />
                </Field>
                <Field label="Hook config format">
                  <select
                    value={cliForm.hook_config_format}
                    onChange={event => setCliField('hook_config_format', event.target.value)}
                    className="h-8 rounded-md border border-x-line bg-x-surface-2 px-3 text-[12px] text-x-ink"
                  >
                    <option value="json">JSON</option>
                    <option value="toml">TOML</option>
                  </select>
                </Field>
                <Field label="MCP strategy">
                  <select
                    value={cliForm.mcp_strategy}
                    onChange={event => setCliField('mcp_strategy', event.target.value)}
                    className="h-8 rounded-md border border-x-line bg-x-surface-2 px-3 text-[12px] text-x-ink"
                  >
                    <option value="config_file">Config file</option>
                    <option value="mcp_add">mcp add command</option>
                    <option value="global_config_file">Global config file</option>
                  </select>
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Canonical-to-native hook map" hint={'e.g. {"pre_tool":"BeforeTool"}'}>
                  <Textarea mono rows={7} value={cliForm.hook_event_map} onChange={event => setCliField('hook_event_map', event.target.value)} />
                </Field>
                <Field label="Default native hook events" hint="comma or newline separated">
                  <Textarea mono rows={7} value={cliForm.default_hook_events} onChange={event => setCliField('default_hook_events', event.target.value)} />
                </Field>
              </div>
            </section>
          </div>
        )}
      </Modal>

      {message && (
        <p className={`flex items-center gap-1.5 text-[11px] ${message.error ? 'text-x-accent-ink' : 'text-x-good'}`}>
          {message.error ? <AlertTriangle size={12} /> : <Check size={12} />}
          {message.text}
        </p>
      )}
          </div>
    </div>
  )
}
