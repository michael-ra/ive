import { isSurfaceAvailable } from './extensionRegistry';
export const IA_GROUPS = [{
  id: 'work',
  label: 'Work',
  description: 'Chat with agents, plan tasks and review work.',
  emptyTitle: 'No workspace yet',
  emptyDescription: 'Add a workspace, then start a session whenever you are ready.',
  surfaces: [{
    id: 'sessions',
    label: 'Sessions',
    description: 'Open a conversation with an AI agent or continue an existing one.'
  }, {
    id: 'feature-board',
    label: 'Feature Board',
    description: 'Organize tasks by status and see what needs attention.'
  }, {
    id: 'pipeline-editor',
    label: 'Pipelines',
    description: 'Build reusable workflows such as plan → implement → verify.'
  }, {
    id: 'inbox',
    label: 'Session Inbox',
    description: 'Read session updates and handoffs that need your attention.'
  }, {
    id: 'search',
    label: 'Search All Sessions',
    description: 'Find earlier conversations by their content. ⌘F searches the open session.'
  }, {
    id: 'import-history',
    label: 'Import Sessions',
    description: 'Bring existing Claude conversations into IVE.'
  }, {
    id: 'quick-feature',
    label: 'Capture Feature',
    description: 'Save an idea as a task to work on later.'
  }]
}, {
  id: 'know',
  label: 'Know',
  description: 'Research questions and give agents useful project knowledge.',
  emptyTitle: 'Nothing indexed yet',
  emptyDescription: 'Add project knowledge, save reusable instructions or research a question.',
  surfaces: [{
    id: 'research',
    label: 'Research',
    description: 'Ask a research question and follow the investigation.'
  }, {
    id: 'research-library',
    label: 'Research Library',
    description: 'Read saved research reports and check their sources.'
  }, {
    id: 'observatory',
    label: 'Discovery Inbox',
    description: 'Review tools, ideas and evidence found by your source scans.'
  }, {
    id: 'smart-observatory',
    label: 'Discovery Setup',
    description: 'Choose which topics and external sources to watch.'
  }, {
    id: 'discovery-insights',
    label: 'Discovery Insights',
    description: 'Read conclusions drawn from discovered sources.'
  }, {
    id: 'docs-panel',
    label: 'Docs Hub',
    description: 'Browse project documentation and see what is missing.'
  }, {
    id: 'memory',
    label: 'Context Hub',
    description: 'Manage saved project knowledge and how context is shared.'
  }, {
    id: 'memory-search',
    label: 'Context Search',
    description: 'Find facts and notes in saved context.'
  }, {
    id: 'prompt-library',
    label: 'Prompt Library',
    description: 'Save instructions you want to use again.'
  }, {
    id: 'cascades',
    label: 'Prompt Cascades',
    description: 'Send a saved sequence of instructions to a session.'
  }, {
    id: 'guidelines',
    label: 'Guidelines',
    description: 'Write reusable rules and conventions for your agents.'
  }, {
    id: 'marketplace',
    label: 'Plugins & Skills',
    description: 'Browse additional tools and reusable agent abilities.'
  }, {
    id: 'skills-library',
    label: 'Agent Skills Library',
    description: 'Review installed and suggested instruction packages for agents.'
  }]
}, {
  id: 'operate',
  label: 'Operate',
  description: 'See ongoing work, requests and model usage.',
  emptyTitle: 'No runtime activity yet',
  emptyDescription: 'Start a session or connect a system to see activity here.',
  surfaces: [{
    id: 'mission-control',
    label: 'Mission Control',
    description: 'Check running sessions, waiting requests and connection health.'
  }, {
    id: 'activity-audit',
    label: 'Activity Logs',
    description: 'See what happened and which actions were recorded.'
  }, {
    id: 'cost',
    label: 'Cost & Tokens',
    description: 'Review recorded model usage and estimated costs.'
  }, {
    id: 'secure',
    label: 'Secure Self-Test',
    description: 'Run security checks on systems you are authorized to test.'
  }, {
    id: 'agent-tree',
    label: 'Agent Tree',
    description: 'See which agents started or supervise other agents.'
  }, {
    id: 'peer-messages',
    label: 'Peer Messages',
    description: 'Read messages agents exchange to coordinate their work.'
  }]
}, {
  id: 'configure',
  label: 'Configure',
  description: 'Set up accounts, project preferences and access.',
  emptyTitle: 'No workspace settings yet',
  emptyDescription: 'Add a workspace to configure workspace-specific behaviour.',
  surfaces: [{
    id: 'connectors',
    label: 'Connectors',
    description: 'Apps, AI accounts, and custom connections in one place.'
  }, {
    id: 'general-settings',
    label: 'General Settings',
    description: 'Theme and defaults.'
  }, {
    id: 'mac-power',
    label: 'Mac & Energie',
    description: 'Agenten bei geschlossenem Deckel weiterarbeiten lassen und dabei Strom sparen.'
  }, {
    id: 'model-providers',
    label: 'Model Providers',
    description: 'Choose AI providers, model defaults and connection settings.'
  }, {
    id: 'workspace-settings',
    label: 'Workspace Settings',
    description: 'Change settings for one connected project.'
  }, {
    id: 'safety',
    label: 'Safety & Policies',
    description: 'Review which agent actions require approval.'
  }, {
    id: 'config-viewer',
    label: 'Config & Permissions',
    paletteLabel: 'Config Files & Tool Permissions',
    description: 'Inspect the configuration and tool access used by your agents.'
  }, {
    id: 'phone-access',
    label: 'iPhone & Devices',
    description: 'Pair your phone as a remote for this Mac and manage paired devices.'
  }, {
    id: 'sharing',
    label: 'Multiplayer Share',
    description: 'Invite others and control access to shared work.'
  }, {
    id: 'sound-settings',
    label: 'Sound Notifications',
    description: 'Choose sounds for updates and requests.'
  }, {
    id: 'experimental',
    label: 'Experimental Features',
    description: 'Choose whether to try features still under development.'
  }, {
    id: 'grid-templates',
    label: 'Grid Layouts',
    description: 'Arrange several sessions in the Overview.'
  }, {
    id: 'shortcuts',
    label: 'Keyboard Shortcuts',
    description: 'Find and customize keyboard shortcuts.'
  }]
}];
export const SESSION_SURFACES = [{
  id: 'files',
  label: 'Files & Plans'
}, {
  id: 'code-review',
  label: 'Code Review'
}, {
  id: 'plan-viewer',
  label: 'Plan Viewer'
}, {
  id: 'capabilities',
  label: 'Capabilities'
}, {
  id: 'scratchpad',
  label: 'Scratchpad'
}, {
  id: 'annotations',
  label: 'Annotations'
}, {
  id: 'briefing',
  label: 'Catch Up'
}, {
  id: 'distill-session',
  label: 'Distill Session'
}, {
  id: 'broadcast',
  label: 'Broadcast to Sessions'
}];
export const UTILITY_SURFACES = [{
  id: 'command-palette',
  label: 'Command Palette'
}, {
  id: 'new-session',
  label: 'New Session'
}, {
  id: 'new-prompt',
  label: 'New Prompt'
}, {
  id: 'manage-templates',
  label: 'Manage Templates'
}, {
  id: 'quick-actions',
  label: 'Quick Action Palette'
}, {
  id: 'preview',
  label: 'Preview Palette'
}, {
  id: 'add-workspace',
  label: 'Add Workspace'
}];
for (const group of IA_GROUPS) group.surfaces = group.surfaces.filter(surface => isSurfaceAvailable(surface.id));
export const IA_SURFACES = IA_GROUPS.flatMap(group => group.surfaces.map(surface => ({
  ...surface,
  groupId: group.id,
  groupLabel: group.label
})));
export const getIaGroup = id => IA_GROUPS.find(group => group.id === id) || IA_GROUPS[0];
