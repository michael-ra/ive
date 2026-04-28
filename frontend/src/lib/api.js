const BASE = '/api'

export class ApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

async function request(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  })
  // Try to parse JSON regardless — many backend errors include a body.
  let body = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (!res.ok) {
    const msg = (body && (body.error || body.message)) || `HTTP ${res.status}`
    throw new ApiError(msg, { status: res.status, body })
  }
  return body
}

export const api = {
  // Workspaces
  getWorkspaces: () => request('/workspaces'),
  createWorkspace: (path, name) =>
    request('/workspaces', { method: 'POST', body: JSON.stringify({ path, name }) }),
  browseFolder: () =>
    request('/browse-folder', { method: 'POST' }),
  updateWorkspace: (id, data) =>
    request(`/workspaces/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteWorkspace: (id) => request(`/workspaces/${id}`, { method: 'DELETE' }),
  reorderWorkspaces: (ids) =>
    request('/workspaces/order', { method: 'PUT', body: JSON.stringify({ ids }) }),

  // IDE
  openInIde: (workspaceId, file, line) =>
    request('/open-in-ide', { method: 'POST', body: JSON.stringify({ workspace_id: workspaceId, file, line }) }),

  // Git operations (code review)
  getGitStatus: (workspaceId) => request(`/workspaces/${workspaceId}/git/status`),
  getGitDiff: (workspaceId, opts = {}) => {
    const params = []
    if (opts.staged) params.push('staged=1')
    if (opts.range) params.push(`range=${encodeURIComponent(opts.range)}`)
    if (opts.file) params.push(`file=${encodeURIComponent(opts.file)}`)
    return request(`/workspaces/${workspaceId}/git/diff${params.length ? '?' + params.join('&') : ''}`)
  },
  getGitLog: (workspaceId, count = 20) => request(`/workspaces/${workspaceId}/git/log?count=${count}`),

  // Sessions
  getSessions: (workspaceId) =>
    request(workspaceId ? `/sessions?workspace=${workspaceId}` : '/sessions'),
  createSession: (workspaceId, opts = {}) =>
    request('/sessions', { method: 'POST', body: JSON.stringify({ workspace_id: workspaceId, ...opts }) }),
  deleteSession: (id) => request(`/sessions/${id}`, { method: 'DELETE' }),
  reorderSessions: (workspaceId, ids) =>
    request('/sessions/order', { method: 'PUT', body: JSON.stringify({ workspace_id: workspaceId, ids }) }),

  // Grid templates
  getGridTemplates: (workspaceId) =>
    request(workspaceId ? `/grid-templates?workspace=${workspaceId}` : '/grid-templates'),
  createGridTemplate: (tpl) =>
    request('/grid-templates', { method: 'POST', body: JSON.stringify(tpl) }),
  updateGridTemplate: (id, patch) =>
    request(`/grid-templates/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteGridTemplate: (id) =>
    request(`/grid-templates/${id}`, { method: 'DELETE' }),

  // Tab groups
  getTabGroups: (workspaceId) =>
    request(workspaceId ? `/tab-groups?workspace=${workspaceId}` : '/tab-groups'),
  createTabGroup: (data) =>
    request('/tab-groups', { method: 'POST', body: JSON.stringify(data) }),
  updateTabGroup: (id, patch) =>
    request(`/tab-groups/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteTabGroup: (id) =>
    request(`/tab-groups/${id}`, { method: 'DELETE' }),

  // Messages
  getMessages: (sessionId) => request(`/sessions/${sessionId}/messages`),

  // Prompts
  getPrompts: (category) =>
    request(category ? `/prompts?category=${encodeURIComponent(category)}` : '/prompts'),
  createPrompt: (data) =>
    request('/prompts', { method: 'POST', body: JSON.stringify(data) }),
  updatePrompt: (id, data) =>
    request(`/prompts/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deletePrompt: (id) => request(`/prompts/${id}`, { method: 'DELETE' }),
  usePrompt: (id) => request(`/prompts/${id}/use`, { method: 'POST' }),
  getQuickActions: () => request('/prompts?quickaction=1'),
  reorderQuickActions: (ids) =>
    request('/prompts/quickaction-order', { method: 'PUT', body: JSON.stringify({ ids }) }),

  // Agent Skills
  getAgentSkills: () => request('/skills'),
  getAgentSkill: (path, repo) => {
    const params = repo ? `?repo=${encodeURIComponent(repo)}` : ''
    return request(`/skills/${encodeURIComponent(path)}${params}`)
  },
  installAgentSkill: (data) =>
    request('/skills/install', { method: 'POST', body: JSON.stringify(data) }),
  uninstallAgentSkill: (data) =>
    request('/skills/uninstall', { method: 'POST', body: JSON.stringify(data) }),
  getInstalledSkills: (workspaceId, scope) => {
    const params = []
    if (workspaceId) params.push(`workspace_id=${encodeURIComponent(workspaceId)}`)
    if (scope) params.push(`scope=${encodeURIComponent(scope)}`)
    return request(`/skills/installed${params.length ? '?' + params.join('&') : ''}`)
  },
  syncAgentSkill: (data) =>
    request('/skills/sync', { method: 'POST', body: JSON.stringify(data) }),
  searchSkills: (query, limit = 5) =>
    request(`/skills/search?q=${encodeURIComponent(query)}&limit=${limit}`),
  getSkillContent: (name) =>
    request(`/skills/content?name=${encodeURIComponent(name)}`),
  dismissSkillSuggestion: (sessionId, entityId) =>
    request('/skills/dismiss-suggestion', { method: 'POST', body: JSON.stringify({ session_id: sessionId, entity_id: entityId }) }),

  // Guidelines
  getGuidelines: () => request('/guidelines'),
  createGuideline: (data) =>
    request('/guidelines', { method: 'POST', body: JSON.stringify(data) }),
  updateGuideline: (id, data) =>
    request(`/guidelines/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteGuideline: (id) => request(`/guidelines/${id}`, { method: 'DELETE' }),

  // Session scratchpad
  getSessionScratchpad: (sessionId) => request(`/sessions/${sessionId}/scratchpad`),
  updateSessionScratchpad: (sessionId, scratchpad, origin) =>
    request(`/sessions/${sessionId}/scratchpad`, {
      method: 'PUT',
      body: JSON.stringify({ scratchpad, origin }),
    }),

  // Session guidelines
  getSessionGuidelines: (sessionId) => request(`/sessions/${sessionId}/guidelines`),
  setSessionGuidelines: (sessionId, guidelineIds) =>
    request(`/sessions/${sessionId}/guidelines`, {
      method: 'PUT',
      body: JSON.stringify({ guideline_ids: guidelineIds }),
    }),

  // Session Advisor
  getGuidelineRecommendations: (sessionId, opts = {}) => {
    const params = []
    if (opts.limit) params.push(`limit=${opts.limit}`)
    if (opts.min_confidence) params.push(`min_confidence=${opts.min_confidence}`)
    return request(`/sessions/${sessionId}/recommend-guidelines${params.length ? '?' + params.join('&') : ''}`)
  },
  getGuidelineEffectiveness: (workspaceId) => {
    const params = workspaceId ? `?workspace_id=${workspaceId}` : ''
    return request(`/guidelines/effectiveness${params}`)
  },
  analyzeSession: (sessionId) =>
    request(`/sessions/${sessionId}/analyze`, { method: 'POST', body: '{}' }),
  dismissGuidelineRecommendation: (sessionId, guidelineId) =>
    request(`/sessions/${sessionId}/dismiss-recommendation`, {
      method: 'POST',
      body: JSON.stringify({ guideline_id: guidelineId }),
    }),

  // MCP Servers
  getMcpServers: () => request('/mcp-servers'),
  createMcpServer: (data) =>
    request('/mcp-servers', { method: 'POST', body: JSON.stringify(data) }),
  parseMcpDocs: (docs) =>
    request('/mcp-servers/parse-docs', { method: 'POST', body: JSON.stringify({ docs }) }),
  updateMcpServer: (id, data) =>
    request(`/mcp-servers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteMcpServer: (id) => request(`/mcp-servers/${id}`, { method: 'DELETE' }),
  getSessionMcpServers: (sessionId) => request(`/sessions/${sessionId}/mcp-servers`),
  setSessionMcpServers: (sessionId, mcpServerIds, overrides = {}) =>
    request(`/sessions/${sessionId}/mcp-servers`, {
      method: 'PUT',
      body: JSON.stringify({ mcp_server_ids: mcpServerIds, overrides }),
    }),

  // History
  getHistoryProjects: () => request('/history/projects'),
  importHistory: (data) =>
    request('/history/import', { method: 'POST', body: JSON.stringify(data) }),

  // Session management
  updateSession: (id, data) =>
    request(`/sessions/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  renameSession: (id, name) =>
    request(`/sessions/${id}/rename`, { method: 'PUT', body: JSON.stringify({ name }) }),
  cloneSession: (id) =>
    request(`/sessions/${id}/clone`, { method: 'POST' }),
  mergeSessions: (sourceIds, targetId, workspaceId) =>
    request('/sessions/merge', {
      method: 'POST',
      body: JSON.stringify({ source_ids: sourceIds, target_id: targetId, workspace_id: workspaceId }),
    }),
  exportSession: (id, format = 'markdown') =>
    fetch(`${BASE}/sessions/${id}/export?format=${format}`),
  distillSession: (id, data) =>
    request(`/sessions/${id}/distill`, { method: 'POST', body: JSON.stringify(data) }),
  summarizeSession: (id) =>
    request(`/sessions/${id}/summarize`, { method: 'POST', body: JSON.stringify({}) }),

  // Search
  search: (query) => request(`/search?q=${encodeURIComponent(query)}`),

  // Templates
  getTemplates: () => request('/templates'),
  createTemplate: (data) =>
    request('/templates', { method: 'POST', body: JSON.stringify(data) }),
  deleteTemplate: (id) => request(`/templates/${id}`, { method: 'DELETE' }),
  applyTemplate: (id, workspaceId, name) =>
    request(`/templates/${id}/apply`, {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId, name }),
    }),

  // Config
  getCliInfo: () => request('/cli-info'),
  getCliFeatures: () => request('/cli-info/features'),
  getOutputStyles: () => request('/output-styles'),

  // Plan files
  listPlanFiles: (workspaceId) => request(workspaceId ? `/plan-files?workspace_id=${workspaceId}` : '/plan-files'),
  getPlanFile: (path) => request(`/plan-file?path=${encodeURIComponent(path)}`),
  putPlanFile: (path, content) =>
    request('/plan-file', { method: 'PUT', body: JSON.stringify({ path, content }) }),

  // Deep research jobs (subprocess runner — distinct from Research DB CRUD below)
  decomposeResearchPlan: (query) => request('/research/plan', { method: 'POST', body: JSON.stringify({ query }) }),
  startResearch: (data) => request('/research/jobs', { method: 'POST', body: JSON.stringify(data) }),
  listResearchJobs: () => request('/research/jobs'),
  steerResearchJob: (jobId, queries) => request(`/research/jobs/${jobId}/steer`, { method: 'POST', body: JSON.stringify({ queries }) }),
  resumeResearchJob: (jobId, body = {}) => request(`/research/jobs/${jobId}/resume`, { method: 'POST', body: JSON.stringify(body) }),
  stopResearchJob: (jobId) => request(`/research/jobs/${jobId}`, { method: 'DELETE' }),

  // Research schedules (recurring/cron)
  getResearchSchedules: (workspaceId) => request(`/research/schedules${workspaceId ? `?workspace_id=${workspaceId}` : ''}`),
  createResearchSchedule: (data) => request('/research/schedules', { method: 'POST', body: JSON.stringify(data) }),
  updateResearchSchedule: (id, data) => request(`/research/schedules/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteResearchSchedule: (id) => request(`/research/schedules/${id}`, { method: 'DELETE' }),

  // Tasks
  getTasks: (workspaceId, status) => request(workspaceId ? `/tasks?workspace=${workspaceId}${status ? `&status=${status}` : ''}` : '/tasks'),
  createTask: (data) => request('/tasks', { method: 'POST', body: JSON.stringify(data) }),
  getTask: (id) => request(`/tasks/${id}`),
  updateTask2: (id, data) => request(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteTask: (id) => request(`/tasks/${id}`, { method: 'DELETE' }),
  getTaskEvents: (id) => request(`/tasks/${id}/events`),
  iterateTask: (id, data) => request(`/tasks/${id}/iterate`, { method: 'POST', body: JSON.stringify(data) }),

  // Worker queue
  getSessionQueue: (id) => request(`/sessions/${id}/queue`),
  queueTaskForSession: (id, taskId) => request(`/sessions/${id}/queue`, { method: 'POST', body: JSON.stringify({ task_id: taskId }) }),
  assignTaskToWorker: (id, taskId, message) => request(`/sessions/${id}/assign-task`, { method: 'POST', body: JSON.stringify({ task_id: taskId, message }) }),

  // Session output + captures
  getSessionCaptures: (id, type, limit) => request(`/sessions/${id}/captures?type=${type || 'all'}&limit=${limit || 20}`),
  getSessionOutput: (id, lines) => request(`/sessions/${id}/output?lines=${lines || 100}`),

  // Commander + workspace
  startCommander: (workspaceId, opts = {}) => request(`/workspaces/${workspaceId}/commander`, { method: 'POST', body: JSON.stringify(opts) }),
  switchSessionCli: (sessionId, opts) => request(`/sessions/${sessionId}/switch-cli`, { method: 'POST', body: JSON.stringify(opts) }),
  switchModel: (sessionId, model) => request(`/sessions/${sessionId}/switch-model`, { method: 'POST', body: JSON.stringify({ model }) }),
  getCommander: (workspaceId) => request(`/workspaces/${workspaceId}/commander`),
  startTester: (workspaceId, opts = {}) => request(`/workspaces/${workspaceId}/tester`, { method: 'POST', body: JSON.stringify(opts) }),
  getTester: (workspaceId) => request(`/workspaces/${workspaceId}/tester`),
  startDocumentor: (workspaceId, opts = {}) => request(`/workspaces/${workspaceId}/documentor`, { method: 'POST', body: JSON.stringify(opts) }),
  getDocumentor: (workspaceId) => request(`/workspaces/${workspaceId}/documentor`),
  getDocsStatus: (workspaceId) => request(`/workspaces/${workspaceId}/docs`),
  triggerDocsBuild: (workspaceId) => request(`/workspaces/${workspaceId}/docs/build`, { method: 'POST' }),

  // Test Queue
  getTestQueue: (workspaceId) => request(`/workspaces/${workspaceId}/test-queue`),
  enqueueTest: (workspaceId, data) =>
    request(`/workspaces/${workspaceId}/test-queue`, { method: 'POST', body: JSON.stringify(data) }),
  updateTestQueueEntry: (entryId, data) =>
    request(`/test-queue/${entryId}`, { method: 'PUT', body: JSON.stringify(data) }),
  removeFromTestQueue: (entryId) =>
    request(`/test-queue/${entryId}`, { method: 'DELETE' }),

  getWorkspaceOverview: (workspaceId) => request(`/workspaces/${workspaceId}/overview`),
  // Research DB
  getResearch: (workspaceId, feature) => {
    let path = '/research'
    const params = []
    if (workspaceId) params.push(`workspace=${workspaceId}`)
    if (feature) params.push(`feature=${encodeURIComponent(feature)}`)
    if (params.length) path += '?' + params.join('&')
    return request(path)
  },
  createResearch: (data) => request('/research', { method: 'POST', body: JSON.stringify(data) }),
  getResearchEntry: (id) => request(`/research/${id}`),
  updateResearch: (id, data) => request(`/research/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteResearch: (id) => request(`/research/${id}`, { method: 'DELETE' }),
  addResearchSource: (id, source) => request(`/research/${id}/sources`, { method: 'POST', body: JSON.stringify(source) }),
  searchResearch: (query, workspaceId) => request(`/research/search?q=${encodeURIComponent(query)}${workspaceId ? `&workspace=${workspaceId}` : ''}`),

  getAgentsMd: (workspaceId) => request(`/workspaces/${workspaceId}/agents-md`),
  saveAgentsMd: (workspaceId, content) =>
    request(`/workspaces/${workspaceId}/agents-md`, { method: 'PUT', body: JSON.stringify({ content }) }),

  // Session tree + subagents
  getSessionTree: (id) => request(`/sessions/${id}/tree`),
  getSessionSubagents: (id) => request(`/sessions/${id}/subagents`),
  getSubagentTranscript: (sessionId, agentId) => request(`/sessions/${sessionId}/subagents/${agentId}/transcript`),

  // ── Prompt cascades ───────────────────────────────────────────
  getCascades: () => request('/cascades'),
  createCascade: (data) =>
    request('/cascades', { method: 'POST', body: JSON.stringify(data) }),
  updateCascade: (id, data) =>
    request(`/cascades/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteCascade: (id) => request(`/cascades/${id}`, { method: 'DELETE' }),
  useCascade: (id) => request(`/cascades/${id}/use`, { method: 'POST' }),

  // ── Cascade runs (server-side execution) ──────────────────────
  listCascadeRuns: (sessionId, activeOnly) => {
    const params = new URLSearchParams()
    if (sessionId) params.set('session', sessionId)
    if (activeOnly) params.set('active', '1')
    return request(`/cascade-runs?${params}`)
  },
  createCascadeRun: (data) =>
    request('/cascade-runs', { method: 'POST', body: JSON.stringify(data) }),
  getCascadeRun: (id) => request(`/cascade-runs/${id}`),
  updateCascadeRun: (id, action, data = {}) =>
    request(`/cascade-runs/${id}`, { method: 'PUT', body: JSON.stringify({ action, ...data }) }),
  deleteCascadeRun: (id) =>
    request(`/cascade-runs/${id}`, { method: 'DELETE' }),

  // ── Pipelines (configurable graph orchestration) ──────────────
  getPipelines: (workspaceId) =>
    request(workspaceId ? `/pipelines?workspace_id=${workspaceId}` : '/pipelines'),
  getPipeline: (id) => request(`/pipelines/${id}`),
  createPipeline: (data) =>
    request('/pipelines', { method: 'POST', body: JSON.stringify(data) }),
  updatePipeline: (id, data) =>
    request(`/pipelines/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deletePipeline: (id) =>
    request(`/pipelines/${id}`, { method: 'DELETE' }),
  listPipelineRuns: (workspaceId, pipelineId, activeOnly) => {
    const params = new URLSearchParams()
    if (workspaceId) params.set('workspace_id', workspaceId)
    if (pipelineId) params.set('pipeline_id', pipelineId)
    if (activeOnly) params.set('active', '1')
    return request(`/pipeline-runs?${params}`)
  },
  startPipelineRun: (data) =>
    request('/pipeline-runs', { method: 'POST', body: JSON.stringify(data) }),
  getPipelineRun: (id) => request(`/pipeline-runs/${id}`),
  updatePipelineRun: (id, action) =>
    request(`/pipeline-runs/${id}`, { method: 'PUT', body: JSON.stringify({ action }) }),
  startRalphPipeline: (sessionId, task, workspaceId) =>
    request('/pipeline-runs/ralph', { method: 'POST', body: JSON.stringify({ session_id: sessionId, task, workspace_id: workspaceId }) }),

  // ── Broadcast groups ──────────────────────────────────────────
  getBroadcastGroups: (workspaceId) =>
    request(workspaceId ? `/broadcast-groups?workspace=${workspaceId}` : '/broadcast-groups'),
  createBroadcastGroup: (data) =>
    request('/broadcast-groups', { method: 'POST', body: JSON.stringify(data) }),
  updateBroadcastGroup: (id, data) =>
    request(`/broadcast-groups/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteBroadcastGroup: (id) =>
    request(`/broadcast-groups/${id}`, { method: 'DELETE' }),

  // ── App settings + experimental features ──────────────────────
  // Global key/value store. Today the main use is experimental feature
  // flags that must be explicitly opted into from the dashboard.
  getAppSettings: () => request('/settings'),
  getAppSetting: (key) => request(`/settings/${encodeURIComponent(key)}`),
  setAppSetting: (key, value) =>
    request(`/settings/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    }),
  getExperimentalFeatures: () => request('/settings/experimental'),

  // ── Safety Gate ────────────────────────────────────────────────
  getSafetyStatus: () => request('/safety/status'),
  getSafetyRules: (workspaceId) =>
    request(`/safety/rules${workspaceId ? `?workspace_id=${workspaceId}` : ''}`),
  createSafetyRule: (rule) =>
    request('/safety/rules', { method: 'POST', body: JSON.stringify(rule) }),
  updateSafetyRule: (id, data) =>
    request(`/safety/rules/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteSafetyRule: (id) =>
    request(`/safety/rules/${id}`, { method: 'DELETE' }),
  seedSafetyRules: () =>
    request('/safety/rules/seed', { method: 'POST' }),
  getExternalAccessLog: (params = {}) => {
    const qs = new URLSearchParams(params).toString()
    return request(`/safety/access-log${qs ? '?' + qs : ''}`)
  },
  getCommandLog: (params = {}) => {
    const qs = new URLSearchParams(params).toString()
    return request(`/safety/command-log${qs ? '?' + qs : ''}`)
  },
  getPackageScans: (params = {}) => {
    const qs = new URLSearchParams(params).toString()
    return request(`/safety/package-scans${qs ? '?' + qs : ''}`)
  },
  getSafetyDecisions: (params = {}) => {
    const qs = new URLSearchParams(params).toString()
    return request(`/safety/decisions${qs ? '?' + qs : ''}`)
  },
  getInstallScriptPolicy: () => request('/safety/install-script-policy'),
  setInstallScriptPolicy: (blockAll) =>
    request('/safety/install-script-policy', { method: 'PUT', body: JSON.stringify({ block_all: blockAll }) }),
  addInstallScriptAllowlist: (pkg, ecosystem, reason = '') =>
    request('/safety/install-script-allowlist', { method: 'POST', body: JSON.stringify({ package: pkg, ecosystem, reason }) }),
  removeInstallScriptAllowlist: (id) =>
    request(`/safety/install-script-allowlist/${id}`, { method: 'DELETE' }),
  getSafetyProposals: (workspaceId) =>
    request(`/safety/proposals${workspaceId ? `?workspace_id=${workspaceId}` : ''}`),
  acceptSafetyProposal: (id, data) =>
    request(`/safety/proposals/${id}/accept`, { method: 'POST', body: JSON.stringify(data) }),
  dismissSafetyProposal: (id) =>
    request(`/safety/proposals/${id}/dismiss`, { method: 'POST' }),

  // ── Plugin marketplace ─────────────────────────────────────────
  // Two-tier model: locally installed plugins live in the DB and can be
  // attached to sessions; remote registries are discovery servers (URLs)
  // that publish a plugin index. Multiple registries can be configured.
  getPluginRegistries: () => request('/plugins/registries'),
  addPluginRegistry: (data) =>
    request('/plugins/registries', { method: 'POST', body: JSON.stringify(data) }),
  updatePluginRegistry: (id, data) =>
    request(`/plugins/registries/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deletePluginRegistry: (id) =>
    request(`/plugins/registries/${id}`, { method: 'DELETE' }),
  syncPluginRegistry: (id) =>
    request(`/plugins/registries/${id}/sync`, { method: 'POST' }),
  syncAllPluginRegistries: () =>
    request('/plugins/registries/sync', { method: 'POST' }),

  getPlugins: ({ installed, registry } = {}) => {
    const params = []
    if (installed) params.push('installed=1')
    if (registry) params.push(`registry=${encodeURIComponent(registry)}`)
    return request(`/plugins${params.length ? '?' + params.join('&') : ''}`)
  },
  getPlugin: (id) => request(`/plugins/${id}`),
  installPlugin: (id, opts = {}) =>
    request(`/plugins/${id}/install`, { method: 'POST', body: JSON.stringify(opts) }),
  uninstallPlugin: (id) => request(`/plugins/${id}`, { method: 'DELETE' }),

  getSessionPluginComponents: (sessionId) =>
    request(`/sessions/${sessionId}/plugin-components`),
  setSessionPluginComponents: (sessionId, componentIds) =>
    request(`/sessions/${sessionId}/plugin-components`, {
      method: 'PUT',
      body: JSON.stringify({ component_ids: componentIds }),
    }),

  // Accounts
  getAccounts: () => request('/accounts'),
  createAccount: (data) => request('/accounts', { method: 'POST', body: JSON.stringify(data) }),
  updateAccount: (id, data) => request(`/accounts/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAccount: (id) => request(`/accounts/${id}`, { method: 'DELETE' }),
  testAccount: (id) => request(`/accounts/${id}/test`, { method: 'POST' }),
  snapshotAccount: (id) => request(`/accounts/${id}/snapshot`, { method: 'POST' }),
  openAccountBrowser: (id, opts = {}) => {
    // Back-compat: callers used to pass a bare URL string.
    const body = typeof opts === 'string' ? { url: opts } : (opts || {})
    return request(`/accounts/${id}/open-browser`, { method: 'POST', body: JSON.stringify(body) })
  },
  openNextAccount: (opts = {}) => {
    const body = typeof opts === 'string' ? { url: opts } : (opts || {})
    return request('/accounts/open-next', { method: 'POST', body: JSON.stringify(body) })
  },
  restartWithAccount: (sessionId, accountId) =>
    request(`/sessions/${sessionId}/restart-with-account`, { method: 'POST', body: JSON.stringify({ account_id: accountId }) }),
  setupBrowser: (id, cliType) => request(`/accounts/${id}/setup-browser`, {
    method: 'POST', body: JSON.stringify({ cli_type: cliType || undefined }),
  }),
  playwrightAuth: (id, { headless = true, cliType } = {}) =>
    request(`/accounts/${id}/playwright-auth`, {
      method: 'POST', body: JSON.stringify({ headless, cli_type: cliType || undefined }),
    }),
  getAuthStatus: (id) => request(`/accounts/${id}/auth-status`),
  detectBrowsers: () => request('/browser/detect'),
  popOutSession: (sessionId) =>
    request(`/sessions/${sessionId}/pop-out`, { method: 'POST' }),

  // ── W2W: Peer messages ──────────────────────────────────────────
  getPeerMessages: (workspaceId, params = {}) => {
    const qs = new URLSearchParams(params).toString()
    return request(`/workspaces/${workspaceId}/peer-messages${qs ? '?' + qs : ''}`)
  },
  postPeerMessage: (workspaceId, data) =>
    request(`/workspaces/${workspaceId}/peer-messages`, { method: 'POST', body: JSON.stringify(data) }),
  markPeerMessageRead: (id, sessionId) =>
    request(`/peer-messages/${id}/read`, { method: 'PUT', body: JSON.stringify({ session_id: sessionId }) }),

  // ── W2W: Session digests ────────────────────────────────────────
  getSessionDigest: (sessionId) => request(`/sessions/${sessionId}/digest`),
  updateSessionDigest: (sessionId, data) =>
    request(`/sessions/${sessionId}/digest`, { method: 'PUT', body: JSON.stringify(data) }),

  // ── W2W: Workspace knowledge ────────────────────────────────────
  getAllKnowledge: (params = {}) => {
    const qs = new URLSearchParams(params).toString()
    return request(`/knowledge${qs ? '?' + qs : ''}`)
  },
  getWorkspaceKnowledge: (workspaceId, params = {}) => {
    const qs = new URLSearchParams(params).toString()
    return request(`/workspaces/${workspaceId}/knowledge${qs ? '?' + qs : ''}`)
  },
  createKnowledgeEntry: (workspaceId, data) =>
    request(`/workspaces/${workspaceId}/knowledge`, { method: 'POST', body: JSON.stringify(data) }),
  updateKnowledgeEntry: (id, data) =>
    request(`/knowledge/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteKnowledgeEntry: (id) =>
    request(`/knowledge/${id}`, { method: 'DELETE' }),
  confirmKnowledgeEntry: (id) =>
    request(`/knowledge/${id}`, { method: 'PUT', body: JSON.stringify({ action: 'confirm' }) }),
  getKnowledgePrompt: (workspaceId, params = {}) => {
    const qs = new URLSearchParams(params).toString()
    return request(`/workspaces/${workspaceId}/knowledge/prompt${qs ? '?' + qs : ''}`)
  },

  // ── W2W: File activity ──────────────────────────────────────────
  getRecentFileActivity: (workspaceId, params = {}) => {
    const qs = new URLSearchParams(params).toString()
    return request(`/workspaces/${workspaceId}/file-activity${qs ? '?' + qs : ''}`)
  },
  getFileActivity: (workspaceId, filePath) =>
    request(`/workspaces/${workspaceId}/file-activity/file?path=${encodeURIComponent(filePath)}`),

  // ── W2W: Task similarity + knowledge export ─────────────────────
  findSimilarTasks: (query, workspaceId) => {
    const params = new URLSearchParams({ q: query })
    if (workspaceId) params.set('workspace_id', workspaceId)
    return request(`/tasks/similar?${params}`)
  },
  exportKnowledgeToConfig: (workspaceId, data) =>
    request(`/workspaces/${workspaceId}/knowledge/export`, { method: 'POST', body: JSON.stringify(data) }),

  // ── Memory entries (Commander-owned) ────────────────────────────
  listMemoryEntries: (workspaceId, types, sourceCli) => {
    const params = new URLSearchParams()
    if (workspaceId) params.set('workspace', workspaceId)
    if (types) params.set('types', types)
    if (sourceCli) params.set('source_cli', sourceCli)
    return request(`/memory?${params}`)
  },
  createMemoryEntry: (data) =>
    request('/memory', { method: 'POST', body: JSON.stringify(data) }),
  updateMemoryEntry: (id, data) =>
    request(`/memory/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteMemoryEntry: (id) =>
    request(`/memory/${id}`, { method: 'DELETE' }),
  searchMemoryEntries: (query, workspaceId, types) => {
    const params = new URLSearchParams({ q: query })
    if (workspaceId) params.set('workspace', workspaceId)
    if (types) params.set('types', types)
    return request(`/memory/search?${params}`)
  },
  importMemoryFromCli: (workspaceId) =>
    request('/memory/import', { method: 'POST', body: JSON.stringify({ workspace_id: workspaceId }) }),
  compactMemoryEntries: (body) =>
    request('/memory/compact', { method: 'POST', body: JSON.stringify(body || {}) }),
  getMemoryPrompt: (workspaceId) =>
    request(`/memory/prompt${workspaceId ? '?workspace=' + workspaceId : ''}`),

  // ── Workspace memory sync ─────────────────────────────────────
  getWorkspaceMemory: (workspaceId) =>
    request(`/workspaces/${workspaceId}/memory`),
  updateWorkspaceMemory: (workspaceId, content) =>
    request(`/workspaces/${workspaceId}/memory`, { method: 'PUT', body: JSON.stringify({ content }) }),
  syncWorkspaceMemory: (workspaceId, sourceCli) =>
    request(`/workspaces/${workspaceId}/memory/sync`, {
      method: 'POST', body: JSON.stringify(sourceCli ? { source_cli: sourceCli } : {})
    }),
  getWorkspaceMemoryDiff: (workspaceId) =>
    request(`/workspaces/${workspaceId}/memory/diff`),
  resolveWorkspaceMemory: (workspaceId, resolvedContent, pushTo) =>
    request(`/workspaces/${workspaceId}/memory/resolve`, {
      method: 'POST', body: JSON.stringify({ resolved_content: resolvedContent, push_to: pushTo })
    }),
  getWorkspaceMemorySettings: (workspaceId) =>
    request(`/workspaces/${workspaceId}/memory/settings`),
  updateWorkspaceMemorySettings: (workspaceId, settings) =>
    request(`/workspaces/${workspaceId}/memory/settings`, {
      method: 'PUT', body: JSON.stringify(settings)
    }),
  getWorkspaceAutoMemory: (workspaceId) =>
    request(`/workspaces/${workspaceId}/memory/auto`),

  // ── W2W: Unified memory search ─────────────────────────────────
  searchMemory: (workspaceId, query, types = 'tasks,digests,knowledge,messages,files') => {
    const params = new URLSearchParams({ q: query, types })
    return request(`/workspaces/${workspaceId}/memory-search?${params}`)
  },
  checkCoordinationOverlap: (workspaceId, intent, excludeSession) =>
    request(`/workspaces/${workspaceId}/coordination/overlap`, {
      method: 'POST', body: JSON.stringify({ intent, exclude_session: excludeSession })
    }),
  findSimilarSessions: (query, workspaceId, excludeSession) => {
    const params = new URLSearchParams({ q: query })
    if (workspaceId) params.set('workspace_id', workspaceId)
    if (excludeSession) params.set('exclude_session', excludeSession)
    return request(`/sessions/similar?${params}`)
  },

  // ── Observatory ────────────────────────────────────────────────
  getObservatoryFindings: (params = {}) => {
    const qs = new URLSearchParams(params).toString()
    return request(`/observatory/findings${qs ? '?' + qs : ''}`)
  },
  updateObservatoryFinding: (id, data) =>
    request(`/observatory/findings/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteObservatoryFinding: (id) =>
    request(`/observatory/findings/${id}`, { method: 'DELETE' }),
  promoteObservatoryFinding: (id, workspaceId) =>
    request(`/observatory/findings/${id}/promote`, { method: 'POST', body: JSON.stringify({ workspace_id: workspaceId }) }),
  getObservatoryScans: () => request('/observatory/scans'),
  triggerObservatoryScan: (data) =>
    request('/observatory/scan', { method: 'POST', body: JSON.stringify(data) }),
  getObservatorySettings: (workspaceId) =>
    request(`/observatory/settings?workspace_id=${workspaceId}`),
  updateObservatorySettings: (data) =>
    request('/observatory/settings', { method: 'PUT', body: JSON.stringify(data) }),
  getObservatoryApiKeys: () => request('/observatory/api-keys'),
  setObservatoryApiKey: (name, value) =>
    request('/observatory/api-keys', { method: 'PUT', body: JSON.stringify({ name, value }) }),
  testObservatoryApiKey: (name) =>
    request('/observatory/api-keys/test', { method: 'POST', body: JSON.stringify({ name }) }),
  createObservatorist: (workspaceId) =>
    request(`/workspaces/${workspaceId}/observatorist`, { method: 'POST' }),
  // Smart pipeline (profile + curated targets + insights)
  getObservatoryProfile: (workspaceId) =>
    request(`/observatory/profile?workspace_id=${workspaceId}`),
  regenerateObservatoryProfile: (workspaceId) =>
    request('/observatory/profile/regenerate', {
      method: 'POST', body: JSON.stringify({ workspace_id: workspaceId }),
    }),
  updateObservatoryProfile: (workspaceId, profile) =>
    request('/observatory/profile', {
      method: 'PUT', body: JSON.stringify({ workspace_id: workspaceId, profile }),
    }),
  recalibrateObservatoryProfile: (workspaceId) =>
    request('/observatory/profile/recalibrate', {
      method: 'POST', body: JSON.stringify({ workspace_id: workspaceId }),
    }),
  listObservatorySearchTargets: (params = {}) => {
    const qs = new URLSearchParams(params).toString()
    return request(`/observatory/search-targets${qs ? '?' + qs : ''}`)
  },
  addObservatorySearchTarget: (data) =>
    request('/observatory/search-targets', { method: 'POST', body: JSON.stringify(data) }),
  updateObservatorySearchTarget: (id, data) =>
    request(`/observatory/search-targets/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteObservatorySearchTarget: (id) =>
    request(`/observatory/search-targets/${id}`, { method: 'DELETE' }),
  planObservatorySearchTargets: (workspaceId, source) =>
    request('/observatory/search-targets/plan', {
      method: 'POST', body: JSON.stringify({ workspace_id: workspaceId, source }),
    }),
  triggerObservatorySmartScan: (data) =>
    request('/observatory/scan/smart', { method: 'POST', body: JSON.stringify(data) }),
  listObservatoryInsights: (workspaceId, type) => {
    const qs = new URLSearchParams({
      workspace_id: workspaceId, ...(type ? { type } : {}),
    }).toString()
    return request(`/observatory/insights?${qs}`)
  },
  upsertObservatoryInsight: (data) =>
    request('/observatory/insights', { method: 'POST', body: JSON.stringify(data) }),
  updateObservatoryInsight: (id, data) =>
    request(`/observatory/insights/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteObservatoryInsight: (id) =>
    request(`/observatory/insights/${id}`, { method: 'DELETE' }),

  // ── System API Keys ──────────────────────────────────────────────
  getApiKeys: () => request('/api-keys'),
  saveApiKey: (name, value) =>
    request('/api-keys', { method: 'PUT', body: JSON.stringify({ name, value }) }),
  testApiKey: (name) =>
    request('/api-keys/test', { method: 'POST', body: JSON.stringify({ name }) }),

  // ── Invites (access overhaul) ───────────────────────────────────
  // create returns the secret in three projections — exactly once. Lose it
  // and the only recovery is revoke + recreate.
  createInvite: (body) =>
    request('/invite/create', { method: 'POST', body: JSON.stringify(body) }),
  listInvites: () => request('/invites'),
  revokeInvite: (id) =>
    request(`/invite/${id}/revoke`, { method: 'POST' }),
  redeemInvite: (token) =>
    request('/invite/redeem', { method: 'POST', body: JSON.stringify({ token }) }),

  // ── Auth context / per-row joiner sessions (PR 2) ──────────────────
  whoami: () => request('/whoami'),
  listAuthSessions: () => request('/sessions/auth'),
  revokeAuthSession: (id) =>
    request(`/sessions/auth/${id}/revoke`, { method: 'POST' }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  // Runtime tunnel + multiplayer
  // cache: 'no-store' — runtime flags are toggled live; we never want a
  // stale 304/200-from-cache to mask a fresh state change.
  getRuntimeStatus: () => request('/runtime/status', { cache: 'no-store' }),
  startTunnel: () => request('/runtime/tunnel/start', { method: 'POST' }),
  stopTunnel: () => request('/runtime/tunnel/stop', { method: 'POST' }),
  setMultiplayer: (enabled) =>
    request('/runtime/multiplayer', {
      method: 'POST',
      body: JSON.stringify({ enabled: !!enabled }),
    }),

  listAuditLog: ({ actor_id, actor_kind, since, path_prefix, limit } = {}) => {
    const qs = new URLSearchParams()
    if (actor_id) qs.set('actor_id', actor_id)
    if (actor_kind) qs.set('actor_kind', actor_kind)
    if (since) qs.set('since', since)
    if (path_prefix) qs.set('path_prefix', path_prefix)
    if (limit) qs.set('limit', String(limit))
    const q = qs.toString()
    return request(`/audit${q ? `?${q}` : ''}`)
  },

  // ── Catch-me-up digest + Web Push (PR 4) ──────────────────────────
  getCatchup: ({ since, until, workspace_id, limit, llm, cli, model } = {}) => {
    const qs = new URLSearchParams()
    if (since) qs.set('since', since)
    if (until) qs.set('until', until)
    if (workspace_id) qs.set('workspace_id', workspace_id)
    if (limit) qs.set('limit', String(limit))
    if (llm === false) qs.set('llm', 'false')
    if (cli) qs.set('cli', cli)
    if (model) qs.set('model', model)
    const s = qs.toString()
    return request(`/catchup${s ? `?${s}` : ''}`)
  },
  pushVapidPubkey: () => request('/push/vapid-pubkey'),
  subscribePush: (subscription) =>
    request('/push/subscribe', {
      method: 'POST',
      body: JSON.stringify(subscription),
    }),
  unsubscribePush: (endpoint) =>
    request('/push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint }),
    }),
}

// ── Cloudflare-tunnel-aware preview URL helper ────────────────────
// When IVE is being served from a non-loopback origin (typically a
// `*.trycloudflare.com` quick tunnel or an exposed multiplayer host),
// `http://localhost:PORT/...` URLs do NOT resolve on the visitor's
// machine — they'd hit the visitor's own laptop. The backend exposes
// a `/preview/<port>/...` reverse-proxy in those modes; this helper
// returns the right URL based on origin so callers don't have to think
// about it.
//
//   localhost browser  → returns `http://127.0.0.1:<port><path>`
//   tunnel browser     → returns `<origin>/preview/<port><path>`
export function isLocalOrigin() {
  if (typeof window === 'undefined') return true
  const h = window.location.hostname
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === ''
}

export function localPreviewUrl(port, path = '/') {
  const p = path.startsWith('/') ? path : `/${path}`
  if (isLocalOrigin()) {
    return `http://127.0.0.1:${port}${p}`
  }
  // Strip the leading slash from the path because the proxy mount itself
  // ends in `/preview/<port>/`, then re-add the path under it.
  return `${window.location.origin}/preview/${port}${p}`
}

// Rewrite a `http://localhost:PORT/...` or `http://127.0.0.1:PORT/...`
// URL so it routes through the preview proxy when we're served from a
// non-local origin. Anything else is returned unchanged.
export function rewriteLocalPreviewUrl(url) {
  if (!url || isLocalOrigin()) return url
  const m = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)(\/.*)?$/i.exec(url)
  if (!m) return url
  const port = parseInt(m[1], 10)
  const path = m[2] || '/'
  return localPreviewUrl(port, path)
}

// ─── Demo runner ─────────────────────────────────────────────────
// Per-workspace stable dev-server preview. Workers can churn freely
// without restarting this; operators promote new builds via pullLatest.
export const demoApi = {
  status: (wsId) => request(`/workspaces/${wsId}/demo`),
  start: (wsId, body = {}) =>
    request(`/workspaces/${wsId}/demo/start`, { method: 'POST', body: JSON.stringify(body) }),
  stop: (wsId) =>
    request(`/workspaces/${wsId}/demo/stop`, { method: 'POST' }),
  pullLatest: (wsId) =>
    request(`/workspaces/${wsId}/demo/pull-latest`, { method: 'POST' }),
  log: (wsId) => request(`/workspaces/${wsId}/demo/log`),
  list: () => request('/demos'),
}
