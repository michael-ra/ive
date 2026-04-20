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

  // Guidelines
  getGuidelines: () => request('/guidelines'),
  createGuideline: (data) =>
    request('/guidelines', { method: 'POST', body: JSON.stringify(data) }),
  updateGuideline: (id, data) =>
    request(`/guidelines/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteGuideline: (id) => request(`/guidelines/${id}`, { method: 'DELETE' }),

  // Session scratchpad
  getSessionScratchpad: (sessionId) => request(`/sessions/${sessionId}/scratchpad`),
  updateSessionScratchpad: (sessionId, scratchpad) =>
    request(`/sessions/${sessionId}/scratchpad`, {
      method: 'PUT',
      body: JSON.stringify({ scratchpad }),
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
  startResearch: (data) => request('/research/jobs', { method: 'POST', body: JSON.stringify(data) }),
  listResearchJobs: () => request('/research/jobs'),
  stopResearchJob: (jobId) => request(`/research/jobs/${jobId}`, { method: 'DELETE' }),

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
  getSafetyDecisions: (params = {}) => {
    const qs = new URLSearchParams(params).toString()
    return request(`/safety/decisions${qs ? '?' + qs : ''}`)
  },
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
  openAccountBrowser: (id, url) => request(`/accounts/${id}/open-browser`, { method: 'POST', body: JSON.stringify({ url }) }),
  openNextAccount: (url) => request('/accounts/open-next', { method: 'POST', body: JSON.stringify({ url }) }),
  restartWithAccount: (sessionId, accountId) =>
    request(`/sessions/${sessionId}/restart-with-account`, { method: 'POST', body: JSON.stringify({ account_id: accountId }) }),
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
}
