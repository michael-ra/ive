import HelpDetails from '../ui/HelpDetails'
import { useEffect, useState } from 'react'
import { Settings, X } from 'lucide-react'
import { IA_GROUPS } from '../../lib/informationArchitecture'
import AccountManager from '../command/AccountManager'
import ConnectorsPanel from './ConnectorsPanel'
import GridTemplateEditor from '../command/GridTemplateEditor'
import ShortcutsPanel from '../command/ShortcutsPanel'
import ConfigViewer from '../session/ConfigViewer'
import ApiKeysPanel from './ApiKeysPanel'
import ExperimentalPanel from './ExperimentalPanel'
import GeneralSettingsPanel from './GeneralSettingsPanel'
import ModelProvidersPanel from './ModelProvidersPanel'
import SafetyPanel from './SafetyPanel'
import SharingPanel from './SharingPanel'
import PhonePanel from './PhonePanel'
import MacPowerPanel from './MacPowerPanel'
import SoundSettingsPanel from './SoundSettingsPanel'
import WorkspaceSettingsPanel, { WORKSPACE_SETTING_SECTIONS } from './WorkspaceSettingsPanel'
import { Button, IconButton } from '../ui'

const CONFIGURE_SURFACES = IA_GROUPS.find(group => group.id === 'configure').surfaces
const SURFACE_BY_ID = new Map(CONFIGURE_SURFACES.map(surface => [surface.id, surface]))

export const SETTINGS_GROUPS = [
  {
    label: 'This machine',
    sectionIds: ['general-settings', 'mac-power', 'sound-settings', 'shortcuts'],
  },
  {
    label: 'This workspace',
    sectionIds: ['workspace-settings', 'grid-templates'],
  },
  {
    label: 'Connections & models',
    sectionIds: ['connectors', 'model-providers'],
  },
  {
    label: 'Agents & boundaries',
    sectionIds: ['safety', 'config-viewer'],
  },
  {
    label: 'Access & sharing',
    sectionIds: ['phone-access', 'sharing'],
  },
  {
    label: 'Advanced',
    sectionIds: ['experimental'],
  },
]

const SECTION_COMPONENTS = {
  'general-settings': GeneralSettingsPanel,
  'model-providers': ModelProvidersPanel,
  'workspace-settings': WorkspaceSettingsPanel,
  safety: SafetyPanel,
  'config-viewer': ConfigViewer,
  'api-keys': ApiKeysPanel,
  sharing: SharingPanel,
  'phone-access': PhonePanel,
  'mac-power': MacPowerPanel,
  accounts: AccountManager,
  connectors: ConnectorsPanel,
  'sound-settings': SoundSettingsPanel,
  experimental: ExperimentalPanel,
  'grid-templates': GridTemplateEditor,
  shortcuts: ShortcutsPanel,
}

const WORKSPACE_SECTION_IDS = new Set(WORKSPACE_SETTING_SECTIONS.map(section => section.id))

function workspaceSectionFromHash() {
  if (typeof window === 'undefined') return 'identity'
  const match = window.location.hash.match(/^#workspace-settings-(.+)$/)
  return match && WORKSPACE_SECTION_IDS.has(match[1]) ? match[1] : 'identity'
}

export default function SettingsShell({
  sectionId,
  onSectionChange,
  onClose,
  workspaceId,
  sharingInitialTab = 'online',
}) {
  const [workspaceSectionId, setWorkspaceSectionId] = useState(workspaceSectionFromHash)
  const isConnectorAlias = ['accounts', 'api-keys', 'mcp-servers', 'apis-integrations'].includes(sectionId)
  const activeId = isConnectorAlias ? 'connectors' : SURFACE_BY_ID.has(sectionId) ? sectionId : 'general-settings'
  const activeSurface = SURFACE_BY_ID.get(activeId)
  const ActiveSection = SECTION_COMPONENTS[activeId]
  const sectionProps = activeId === 'workspace-settings'
    ? { initialWorkspaceId: workspaceId, activeSectionId: workspaceSectionId }
    : activeId === 'sharing'
      ? { initialTab: sharingInitialTab }
      : activeId === 'connectors'
        ? { initialView: isConnectorAlias ? sectionId : '', onNavigate: onSectionChange }
        : activeId === 'phone-access'
          ? { onNavigate: onSectionChange }
          : {}

  useEffect(() => {
    const syncWorkspaceHash = () => {
      const next = workspaceSectionFromHash()
      if (WORKSPACE_SECTION_IDS.has(next)) setWorkspaceSectionId(next)
    }
    window.addEventListener('hashchange', syncWorkspaceHash)
    return () => window.removeEventListener('hashchange', syncWorkspaceHash)
  }, [])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-x-scrim p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-shell-title"
      data-settings-shell
      data-settings-section={activeId}
      onClick={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="x-panel scale-in flex h-[min(88vh,900px)] w-[min(1180px,calc(100vw-24px))] min-h-0 flex-col overflow-hidden">
        <header className="flex shrink-0 items-center gap-2 border-b border-x-line px-4 py-3">
          <Settings size={16} className="text-x-accent" />
          <div className="min-w-0">
            <h2 id="settings-shell-title" className="truncate text-sm font-semibold text-x-ink">
              {activeSurface.label}
            </h2>
            <HelpDetails key={activeId}><p>{activeSurface.description}</p></HelpDetails>
          </div>
          <div className="flex-1" />
          <IconButton icon={X} label="Close settings" size="sm" onClick={onClose} />
        </header>

        <div className="flex min-h-0 flex-1">
          <aside data-settings-sidebar className="w-[220px] shrink-0 overflow-y-auto border-r border-x-line bg-x-surface-2/45 px-3 py-4 max-sm:w-[164px] max-sm:px-2">
            <nav aria-label="Settings sections" className="space-y-4">
              {SETTINGS_GROUPS.map(group => (
                <div key={group.label}>
                  <h3 className="mb-1.5 px-2 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-x-faint">
                    {group.label}
                  </h3>
                  <div className="space-y-1">
                    {group.sectionIds.map(id => {
                      const surface = SURFACE_BY_ID.get(id)
                      const selected = id === activeId
                      return (
                        <div key={id}>
                          <Button
                            aria-current={selected ? 'page' : undefined}
                            data-settings-nav={id}
                            onClick={() => onSectionChange(id)}
                            selected={selected}
                            className="w-full justify-start"
                          >
                            {surface.label}
                          </Button>
                          {selected && id === 'workspace-settings' && (
                            <div
                              role="group"
                              aria-label="Workspace settings categories"
                              data-workspace-settings-section-nav
                              className="ml-2 mt-1 space-y-1 border-l border-x-line pl-2"
                            >
                              {WORKSPACE_SETTING_SECTIONS.map(section => (
                                <a
                                  key={section.id}
                                  href={`#workspace-settings-${section.id}`}
                                  data-workspace-settings-section={section.id}
                                  aria-current={workspaceSectionId === section.id ? 'page' : undefined}
                                  onClick={() => setWorkspaceSectionId(section.id)}
                                  className={`flex min-h-[24px] w-full items-center rounded-md border px-2 py-1 text-[11px] font-medium transition-colors duration-[80ms] ease-x focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-x-focus ${
                                    workspaceSectionId === section.id
                                      ? 'border-x-line-strong bg-x-surface text-x-ink'
                                      : 'border-transparent bg-transparent text-x-muted hover:bg-x-hover hover:text-x-ink'
                                  }`}
                                  title={section.label}
                                >
                                  <span className="truncate">{section.label}</span>
                                </a>
                              ))}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </nav>
          </aside>

          <main className="min-w-0 flex-1 overflow-hidden bg-x-surface" data-settings-content={activeId}>
            <ActiveSection key={sectionId} {...sectionProps} />
          </main>
        </div>
      </div>
    </div>
  )
}
