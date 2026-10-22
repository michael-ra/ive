import { apiBase } from './platform';
export class ApiError extends Error {
  constructor(message, {
    status,
    body
  } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}
export async function request(path, opts = {}) {
  const res = await fetch(`${apiBase()}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...opts.headers
    },
    ...opts
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    // 423: a paired phone is PIN-locked (idle) or needs a fresh PIN for a
    // sensitive action. PhoneLockOverlay listens and asks for the PIN.
    if (res.status === 423 && typeof window !== 'undefined') {
      try {
        window.dispatchEvent(new CustomEvent('ive:phone-locked', { detail: body || {} }));
      } catch { /* non-DOM environment */ }
    }
    const msg = body && (body.error || body.message) || `HTTP ${res.status}`;
    throw new ApiError(msg, {
      status: res.status,
      body
    });
  }
  return body;
}
export const api = {
  getSidechatOptions: () => request('/sidechat/options', { signal: AbortSignal.timeout(15000) }),
  askSidechat: data => request('/sidechat/ask', { method: 'POST', body: JSON.stringify(data), signal: AbortSignal.timeout(15000) }),
  getSidechatRequest: id => request(`/sidechat/requests/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(15000) }),
  cancelSidechatRequest: id => request(`/sidechat/requests/${encodeURIComponent(id)}`, { method: 'DELETE', signal: AbortSignal.timeout(15000) }),
  getOverview: () => request('/overview'),
  getWorkspaces: () => request('/workspaces'),
  searchProjects: (query, signal) => request(`/project-search?q=${encodeURIComponent(query)}`, { signal }),
  createWorkspace: (path, name) => request('/workspaces', {
    method: 'POST',
    body: JSON.stringify({
      path,
      name
    })
  }),
  browseFolder: () => request('/browse-folder', {
    method: 'POST'
  }),
  updateWorkspace: (id, data) => request(`/workspaces/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  }),
  deleteWorkspace: id => request(`/workspaces/${id}`, {
    method: 'DELETE'
  }),
  reorderWorkspaces: ids => request('/workspaces/order', {
    method: 'PUT',
    body: JSON.stringify({
      ids
    })
  }),
  getWorkspaceRuntimeEnv: id => request(`/workspaces/${id}/runtime-env`),
  openInIde: (workspaceId, file, line) => request('/open-in-ide', {
    method: 'POST',
    body: JSON.stringify({
      workspace_id: workspaceId,
      file,
      line
    })
  }),
  getWorkspaceFiles: (workspaceId, path = '') => request(`/workspaces/${workspaceId}/files?path=${encodeURIComponent(path)}`),
  getGitStatus: workspaceId => request(`/workspaces/${workspaceId}/git/status`),
  getGitDiff: (workspaceId, opts = {}) => {
    const params = [];
    if (opts.staged) params.push('staged=1');
    if (opts.range) params.push(`range=${encodeURIComponent(opts.range)}`);
    if (opts.file) params.push(`file=${encodeURIComponent(opts.file)}`);
    return request(`/workspaces/${workspaceId}/git/diff${params.length ? '?' + params.join('&') : ''}`);
  },
  getGitLog: (workspaceId, count = 20) => request(`/workspaces/${workspaceId}/git/log?count=${count}`),
  composeReviewBrief: data => request('/review/brief', {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  stageGitFile: (workspaceId, file) => request(`/workspaces/${workspaceId}/git/stage`, {
    method: 'POST',
    body: JSON.stringify({
      file
    })
  }),
  unstageGitFile: (workspaceId, file) => request(`/workspaces/${workspaceId}/git/unstage`, {
    method: 'POST',
    body: JSON.stringify({
      file
    })
  }),
  getSessions: workspaceId => request(workspaceId ? `/sessions?workspace=${workspaceId}` : '/sessions'),
  getSessionCapabilities: id => request(`/sessions/${encodeURIComponent(id)}/capabilities`),
  getSessionRuntimeModel: id => request(`/sessions/${encodeURIComponent(id)}/runtime-model`),
  createSession: (workspaceId, opts = {}) => request('/sessions', {
    method: 'POST',
    body: JSON.stringify({
      workspace_id: workspaceId,
      ...opts
    })
  }),
  // Quick start: a session without choosing a workspace (see QUICKSTART-CONTRACT.md).
  getQuickStart: () => request('/quick-start'),
  setQuickStart: root => request('/quick-start', {
    method: 'PUT',
    body: JSON.stringify({ root })
  }),
  ensureQuickWorkspace: () => request('/quick-start/workspace', { method: 'POST' }),
  quickSession: (opts = {}) => request('/sessions/quick', {
    method: 'POST',
    body: JSON.stringify(opts)
  }),
  attachSession: (id, target = {}) => request(`/sessions/${encodeURIComponent(id)}/attach`, {
    method: 'POST',
    body: JSON.stringify(target)
  }),
  getProjectHint: id => request(`/sessions/${encodeURIComponent(id)}/project-hint`),
  deleteSession: id => request(`/sessions/${id}`, {
    method: 'DELETE'
  }),
  reorderSessions: (workspaceId, ids) => request('/sessions/order', {
    method: 'PUT',
    body: JSON.stringify({
      workspace_id: workspaceId,
      ids
    })
  }),
  getGridTemplates: workspaceId => request(workspaceId ? `/grid-templates?workspace=${workspaceId}` : '/grid-templates'),
  createGridTemplate: tpl => request('/grid-templates', {
    method: 'POST',
    body: JSON.stringify(tpl)
  }),
  updateGridTemplate: (id, patch) => request(`/grid-templates/${id}`, {
    method: 'PUT',
    body: JSON.stringify(patch)
  }),
  deleteGridTemplate: id => request(`/grid-templates/${id}`, {
    method: 'DELETE'
  }),
  getTabGroups: workspaceId => request(workspaceId ? `/tab-groups?workspace=${workspaceId}` : '/tab-groups'),
  createTabGroup: data => request('/tab-groups', {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  updateTabGroup: (id, patch) => request(`/tab-groups/${id}`, {
    method: 'PUT',
    body: JSON.stringify(patch)
  }),
  deleteTabGroup: id => request(`/tab-groups/${id}`, {
    method: 'DELETE'
  }),
  getMessages: (sessionId, cursor, { tail } = {}) => request(cursor === undefined
    ? `/sessions/${sessionId}/messages`
    : `/sessions/${sessionId}/messages?cursor=${encodeURIComponent(cursor || '')}${tail ? `&tail=${tail}` : ''}`),
  // Older transcript rows before position `before` ("<generation>:<pos>").
  getOlderMessages: (sessionId, before, limit) => request(
    `/sessions/${sessionId}/messages?before=${encodeURIComponent(before)}&limit=${limit}`),
  getMessageFull: (sessionId, messageId) => request(`/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/full`),
  getSessionFilePreview: (sessionId, filePath) => request(`/sessions/${encodeURIComponent(sessionId)}/file-preview?path=${encodeURIComponent(filePath)}`),
  sessionFilePreviewContentUrl: (sessionId, filePath) => `${apiBase()}/sessions/${encodeURIComponent(sessionId)}/file-preview/content?path=${encodeURIComponent(filePath)}`,
  getPrompts: category => request(category ? `/prompts?category=${encodeURIComponent(category)}` : '/prompts'),
  createPrompt: data => request('/prompts', {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  updatePrompt: (id, data) => request(`/prompts/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  }),
  deletePrompt: id => request(`/prompts/${id}`, {
    method: 'DELETE'
  }),
  usePrompt: id => request(`/prompts/${id}/use`, {
    method: 'POST'
  }),
  getQuickActions: () => request('/prompts?quickaction=1'),
  reorderQuickActions: ids => request('/prompts/quickaction-order', {
    method: 'PUT',
    body: JSON.stringify({
      ids
    })
  }),
  getAgentSkills: () => request('/skills'),
  getAgentSkill: (path, repo) => {
    const params = repo ? `?repo=${encodeURIComponent(repo)}` : '';
    return request(`/skills/${encodeURIComponent(path)}${params}`);
  },
  installAgentSkill: data => request('/skills/install', {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  uninstallAgentSkill: data => request('/skills/uninstall', {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  getInstalledSkills: (workspaceId, scope) => {
    const params = [];
    if (workspaceId) params.push(`workspace_id=${encodeURIComponent(workspaceId)}`);
    if (scope) params.push(`scope=${encodeURIComponent(scope)}`);
    return request(`/skills/installed${params.length ? '?' + params.join('&') : ''}`);
  },
  syncAgentSkill: data => request('/skills/sync', {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  searchSkills: (query, limit = 5) => request(`/skills/search?q=${encodeURIComponent(query)}&limit=${limit}`),
  getSkillContent: name => request(`/skills/content?name=${encodeURIComponent(name)}`),
  dismissSkillSuggestion: (sessionId, entityId) => request('/skills/dismiss-suggestion', {
    method: 'POST',
    body: JSON.stringify({
      session_id: sessionId,
      entity_id: entityId
    })
  }),
  getGuidelines: () => request('/guidelines'),
  createGuideline: data => request('/guidelines', {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  updateGuideline: (id, data) => request(`/guidelines/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  }),
  deleteGuideline: id => request(`/guidelines/${id}`, {
    method: 'DELETE'
  }),
  getSessionScratchpad: sessionId => request(`/sessions/${sessionId}/scratchpad`),
  updateSessionScratchpad: (sessionId, scratchpad, origin) => request(`/sessions/${sessionId}/scratchpad`, {
    method: 'PUT',
    body: JSON.stringify({
      scratchpad,
      origin
    })
  }),
  getSessionGuidelines: sessionId => request(`/sessions/${sessionId}/guidelines`),
  setSessionGuidelines: (sessionId, guidelineIds) => request(`/sessions/${sessionId}/guidelines`, {
    method: 'PUT',
    body: JSON.stringify({
      guideline_ids: guidelineIds
    })
  }),
  getMcpServers: () => request('/mcp-servers'),
  createMcpServer: data => request('/mcp-servers', {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  parseMcpDocs: docs => request('/mcp-servers/parse-docs', {
    method: 'POST',
    body: JSON.stringify({
      docs
    })
  }),
  updateMcpServer: (id, data) => request(`/mcp-servers/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  }),
  deleteMcpServer: id => request(`/mcp-servers/${id}`, {
    method: 'DELETE'
  }),
  getSessionMcpServers: sessionId => request(`/sessions/${sessionId}/mcp-servers`),
  setSessionMcpServers: (sessionId, mcpServerIds, overrides = {}) => request(`/sessions/${sessionId}/mcp-servers`, {
    method: 'PUT',
    body: JSON.stringify({
      mcp_server_ids: mcpServerIds,
      overrides
    })
  }),
  getHistoryProjects: () => request('/history/projects'),
  importHistory: data => request('/history/import', {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  updateSession: (id, data) => request(`/sessions/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  }),
  sendSessionInput: (id, message, opts = {}) => request(`/sessions/${id}/input`, {
    method: 'POST',
    body: JSON.stringify({
      message,
      ...opts
    })
  }),
  getProviderLimits: (sessionId) => request(`/provider-limits${sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ''}`),
  renameSession: (id, name) => request(`/sessions/${id}/rename`, {
    method: 'PUT',
    body: JSON.stringify({
      name
    })
  }),
  cloneSession: (id, options = {}) => request(`/sessions/${id}/clone`, {
    method: 'POST',
    body: JSON.stringify(options)
  }),
  mergeSessions: (sourceIds, targetId, workspaceId) => request('/sessions/merge', {
    method: 'POST',
    body: JSON.stringify({
      source_ids: sourceIds,
      target_id: targetId,
      workspace_id: workspaceId
    })
  }),
  exportSession: (id, format = 'markdown') => fetch(`${apiBase()}/sessions/${id}/export?format=${format}`),
  distillSession: (id, data) => request(`/sessions/${id}/distill`, {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  summarizeSession: id => request(`/sessions/${id}/summarize`, {
    method: 'POST',
    body: JSON.stringify({})
  }),
  search: query => request(`/search?q=${encodeURIComponent(query)}`),
  getTemplates: () => request('/templates'),
  createTemplate: data => request('/templates', {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  deleteTemplate: id => request(`/templates/${id}`, {
    method: 'DELETE'
  }),
  applyTemplate: (id, workspaceId, overrides = {}) => request(`/templates/${id}/apply`, {
    method: 'POST',
    body: JSON.stringify({
      workspace_id: workspaceId,
      ...overrides
    })
  }),
  getCliInfo: () => request('/cli-info'),
  getCliFeatures: () => request('/cli-info/features'),
  getOutputStyles: () => request('/output-styles'),
  getRtkIntegration: () => request('/integrations/rtk'),
  updateRtkIntegration: data => request('/integrations/rtk', {
    method: 'PUT',
    body: JSON.stringify(data)
  }),
  installRtkIntegration: data => request('/integrations/rtk/install', {
    method: 'POST',
    body: JSON.stringify(data || {})
  }),
  listAlloyServers: workspaceId => request(`/workspaces/${workspaceId}/alloy/servers`),
  getAlloyServer: (workspaceId, serverId) => request(`/workspaces/${workspaceId}/alloy/servers/${encodeURIComponent(serverId)}`),
  listAlloyRuns: (workspaceId, opts = {}) => {
    const params = new URLSearchParams();
    if (opts.server_id) params.set('server_id', opts.server_id);
    if (opts.limit) params.set('limit', String(opts.limit));
    const q = params.toString();
    return request(`/workspaces/${workspaceId}/alloy/runs${q ? `?${q}` : ''}`);
  },
  healthcheckAlloyServer: (workspaceId, serverId) => request(`/workspaces/${workspaceId}/alloy/servers/${encodeURIComponent(serverId)}/healthcheck`, {
    method: 'POST',
    body: '{}'
  }),
  listAlloyTools: (workspaceId, serverId) => request(`/workspaces/${workspaceId}/alloy/servers/${encodeURIComponent(serverId)}/tools`),
  callAlloyTool: (workspaceId, serverId, data) => request(`/workspaces/${workspaceId}/alloy/servers/${encodeURIComponent(serverId)}/call`, {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  listPlanFiles: workspaceId => request(workspaceId ? `/plan-files?workspace_id=${workspaceId}` : '/plan-files'),
  getPlanFile: path => request(`/plan-file?path=${encodeURIComponent(path)}`),
  putPlanFile: (path, content) => request('/plan-file', {
    method: 'PUT',
    body: JSON.stringify({
      path,
      content
    })
  }),
  decomposeResearchPlan: query => request('/research/plan', {
    method: 'POST',
    body: JSON.stringify({
      query
    })
  }),
  startResearch: data => request('/research/jobs', {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  listResearchJobs: () => request('/research/jobs'),
  steerResearchJob: (jobId, queries) => request(`/research/jobs/${jobId}/steer`, {
    method: 'POST',
    body: JSON.stringify({
      queries
    })
  }),
  resumeResearchJob: (jobId, body = {}) => request(`/research/jobs/${jobId}/resume`, {
    method: 'POST',
    body: JSON.stringify(body)
  }),
  stopResearchJob: jobId => request(`/research/jobs/${jobId}`, {
    method: 'DELETE'
  }),
  getResearchSchedules: workspaceId => request(`/research/schedules${workspaceId ? `?workspace_id=${workspaceId}` : ''}`),
  createResearchSchedule: data => request('/research/schedules', {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  updateResearchSchedule: (id, data) => request(`/research/schedules/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  }),
  deleteResearchSchedule: id => request(`/research/schedules/${id}`, {
    method: 'DELETE'
  }),
  getTasks: (workspaceId, status) => request(workspaceId ? `/tasks?workspace=${workspaceId}${status ? `&status=${status}` : ''}` : '/tasks'),
  createTask: data => request('/tasks', {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  getTask: (id, opts = {}) => request(`/tasks/${id}`, opts),
  taskReady: id => request(`/tasks/${id}/ready`),
  dispatchTaskWhenReady: (id, data = {}) => request(`/tasks/${id}/dispatch-when-ready`, {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  updateTask2: (id, data) => request(`/tasks/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  }),
  approveBlueprint: (id, data = {}) => request(`/tasks/${id}/approve-blueprint`, {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  reviseBlueprint: (id, data = {}) => request(`/tasks/${id}/revise-blueprint`, {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  executeTask: (id, data = {}) => request(`/tasks/${id}/execute`, {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  deleteTask: id => request(`/tasks/${id}`, {
    method: 'DELETE'
  }),
  getTaskEvents: id => request(`/tasks/${id}/events`),
  iterateTask: (id, data) => request(`/tasks/${id}/iterate`, {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  getSessionQueue: id => request(`/sessions/${id}/queue`),
  queueTaskForSession: (id, taskId) => request(`/sessions/${id}/queue`, {
    method: 'POST',
    body: JSON.stringify({
      task_id: taskId
    })
  }),
  assignTaskToWorker: (id, taskId, message) => request(`/sessions/${id}/assign-task`, {
    method: 'POST',
    body: JSON.stringify({
      task_id: taskId,
      message
    })
  }),
  getSessionCaptures: (id, type, limit) => request(`/sessions/${id}/captures?type=${type || 'all'}&limit=${limit || 20}`),
  getSessionOutput: (id, lines, opts = {}) => request(`/sessions/${id}/output?lines=${lines || 100}${opts.permission_view ? '&permission_view=1' : ''}`),
  startCommander: (workspaceId, opts = {}) => request(`/workspaces/${workspaceId}/commander`, {
    method: 'POST',
    body: JSON.stringify(opts)
  }),
  startBrainstormer: (workspaceId, opts = {}) => request(`/workspaces/${workspaceId}/brainstormer`, {
    method: 'POST',
    body: JSON.stringify(opts)
  }),
  updateBrainstormerPrivacy: (workspaceId, isPublic) => request(`/workspaces/${workspaceId}/brainstormer/privacy`, {
    method: 'PUT',
    body: JSON.stringify({
      public: !!isPublic
    })
  }),
  listPublicBrainstormers: workspaceId => request(`/workspaces/${workspaceId}/brainstormers/public`),
  switchSessionCli: (sessionId, opts) => request(`/sessions/${sessionId}/switch-cli`, {
    method: 'POST',
    body: JSON.stringify(opts)
  }),
  switchModel: (sessionId, model) => request(`/sessions/${sessionId}/switch-model`, {
    method: 'POST',
    body: JSON.stringify({
      model
    })
  }),
  getCommander: workspaceId => request(`/workspaces/${workspaceId}/commander`),
  getBrainstormer: workspaceId => request(`/workspaces/${workspaceId}/brainstormer`),
  getDocsStatus: workspaceId => request(`/workspaces/${workspaceId}/docs`),
  triggerDocsBuild: workspaceId => request(`/workspaces/${workspaceId}/docs/build`, {
    method: 'POST'
  }),
  getTestQueue: workspaceId => request(`/workspaces/${workspaceId}/test-queue`),
  enqueueTest: (workspaceId, data) => request(`/workspaces/${workspaceId}/test-queue`, {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  updateTestQueueEntry: (entryId, data) => request(`/test-queue/${entryId}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  }),
  removeFromTestQueue: entryId => request(`/test-queue/${entryId}`, {
    method: 'DELETE'
  }),
  getWorkspaceOverview: workspaceId => request(`/workspaces/${workspaceId}/overview`),
  getResearch: (workspaceId, feature) => {
    let path = '/research';
    const params = [];
    if (workspaceId) params.push(`workspace=${workspaceId}`);
    if (feature) params.push(`feature=${encodeURIComponent(feature)}`);
    if (params.length) path += '?' + params.join('&');
    return request(path);
  },
  createResearch: data => request('/research', {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  getResearchEntry: id => request(`/research/${id}`),
  updateResearch: (id, data) => request(`/research/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  }),
  deleteResearch: id => request(`/research/${id}`, {
    method: 'DELETE'
  }),
  addResearchSource: (id, source) => request(`/research/${id}/sources`, {
    method: 'POST',
    body: JSON.stringify(source)
  }),
  searchResearch: (query, workspaceId) => request(`/research/search?q=${encodeURIComponent(query)}${workspaceId ? `&workspace=${workspaceId}` : ''}`),
  getAgentsMd: workspaceId => request(`/workspaces/${workspaceId}/agents-md`),
  saveAgentsMd: (workspaceId, content) => request(`/workspaces/${workspaceId}/agents-md`, {
    method: 'PUT',
    body: JSON.stringify({
      content
    })
  }),
  getSessionTree: id => request(`/sessions/${id}/tree`),
  getSessionSubagents: id => request(`/sessions/${id}/subagents`),
  getSubagentTranscript: (sessionId, agentId) => request(`/sessions/${sessionId}/subagents/${agentId}/transcript`),
  getCascades: () => request('/cascades'),
  createCascade: data => request('/cascades', {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  updateCascade: (id, data) => request(`/cascades/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  }),
  deleteCascade: id => request(`/cascades/${id}`, {
    method: 'DELETE'
  }),
  useCascade: id => request(`/cascades/${id}/use`, {
    method: 'POST'
  }),
  listCascadeRuns: (sessionId, activeOnly) => {
    const params = new URLSearchParams();
    if (sessionId) params.set('session', sessionId);
    if (activeOnly) params.set('active', '1');
    return request(`/cascade-runs?${params}`);
  },
  createCascadeRun: data => request('/cascade-runs', {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  getCascadeRun: id => request(`/cascade-runs/${id}`),
  updateCascadeRun: (id, action, data = {}) => request(`/cascade-runs/${id}`, {
    method: 'PUT',
    body: JSON.stringify({
      action,
      ...data
    })
  }),
  deleteCascadeRun: id => request(`/cascade-runs/${id}`, {
    method: 'DELETE'
  }),
  getPipelines: workspaceId => request(workspaceId ? `/pipelines?workspace_id=${workspaceId}` : '/pipelines'),
  getPipeline: id => request(`/pipelines/${id}`),
  createPipeline: data => request('/pipelines', {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  updatePipeline: (id, data) => request(`/pipelines/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  }),
  deletePipeline: id => request(`/pipelines/${id}`, {
    method: 'DELETE'
  }),
  listPipelineRuns: (workspaceId, pipelineId, activeOnly, taskId, signal) => {
    const params = new URLSearchParams();
    if (workspaceId) params.set('workspace_id', workspaceId);
    if (pipelineId) params.set('pipeline_id', pipelineId);
    if (taskId) params.set('task_id', taskId);
    if (activeOnly) params.set('active', '1');
    return request(`/pipeline-runs?${params}`, { signal });
  },
  startPipelineRun: data => request('/pipeline-runs', {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  getPipelineRun: id => request(`/pipeline-runs/${id}`),
  updatePipelineRun: (id, action) => request(`/pipeline-runs/${id}`, {
    method: 'PUT',
    body: JSON.stringify({
      action
    })
  }),
  startRalphPipeline: (sessionId, task, workspaceId) => request('/pipeline-runs/ralph', {
    method: 'POST',
    body: JSON.stringify({
      session_id: sessionId,
      task,
      workspace_id: workspaceId
    })
  }),
  getBroadcastGroups: workspaceId => request(workspaceId ? `/broadcast-groups?workspace=${workspaceId}` : '/broadcast-groups'),
  createBroadcastGroup: data => request('/broadcast-groups', {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  updateBroadcastGroup: (id, data) => request(`/broadcast-groups/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  }),
  deleteBroadcastGroup: id => request(`/broadcast-groups/${id}`, {
    method: 'DELETE'
  }),
  getAppSettings: () => request('/settings'),
  getAppSetting: key => request(`/settings/${encodeURIComponent(key)}`),
  setAppSetting: (key, value) => request(`/settings/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: JSON.stringify({
      value
    })
  }),
  getExperimentalFeatures: () => request('/settings/experimental'),
  getModelProviders: () => request('/model-providers'),
  setModelProviders: providers => request('/model-providers', {
    method: 'PUT',
    body: JSON.stringify({
      providers
    })
  }),
  setModelProviderKey: (providerId, value) => request(`/model-providers/${encodeURIComponent(providerId)}/key`, {
    method: 'PUT',
    body: JSON.stringify({
      value
    })
  }),
  getCliProfiles: () => request('/cli-profiles'),
  addCliProfile: profile => request('/cli-profiles', {
    method: 'POST',
    body: JSON.stringify({
      profile
    })
  }),
  dryRunCliProfileHooks: profileId => request(`/cli-profiles/${encodeURIComponent(profileId)}/hooks/dry-run`, {
    method: 'POST',
    body: '{}'
  }),
  confirmCliProfileHooks: (profileId, confirmation) => request(`/cli-profiles/${encodeURIComponent(profileId)}/hooks/confirm`, {
    method: 'POST',
    body: JSON.stringify({
      confirmation,
      confirmed: true
    })
  }),
  getSafetyStatus: () => request('/safety/status'),
  getSafetyClassifierPrompt: workspaceId => request(`/safety/classifier-prompt${workspaceId ? `?workspace_id=${encodeURIComponent(workspaceId)}` : ''}`),
  suggestSafetyAllows: workspaceId => request('/safety/suggest-allows', {
    method: 'POST',
    body: JSON.stringify(workspaceId ? {
      workspace_id: workspaceId
    } : {})
  }),
  getSafetyRules: workspaceId => request(`/safety/rules${workspaceId ? `?workspace_id=${workspaceId}` : ''}`),
  createSafetyRule: rule => request('/safety/rules', {
    method: 'POST',
    body: JSON.stringify(rule)
  }),
  updateSafetyRule: (id, data) => request(`/safety/rules/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  }),
  deleteSafetyRule: id => request(`/safety/rules/${id}`, {
    method: 'DELETE'
  }),
  seedSafetyRules: () => request('/safety/rules/seed', {
    method: 'POST'
  }),
  getExternalAccessLog: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/safety/access-log${qs ? '?' + qs : ''}`);
  },
  getCommandLog: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/safety/command-log${qs ? '?' + qs : ''}`);
  },
  getPackageScans: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/safety/package-scans${qs ? '?' + qs : ''}`);
  },
  getSafetyDecisions: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/safety/decisions${qs ? '?' + qs : ''}`);
  },
  getEvents: (params = {}) => {
    const qs = new URLSearchParams();
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.type) qs.set('type', params.type);
    if (params.workspace) qs.set('workspace', params.workspace);
    if (params.session) qs.set('session', params.session);
    if (params.task) qs.set('task', params.task);
    if (params.since_id) qs.set('since_id', String(params.since_id));
    const q = qs.toString();
    return request(`/events${q ? `?${q}` : ''}`);
  },
  getInstallScriptPolicy: () => request('/safety/install-script-policy'),
  setInstallScriptPolicy: blockAll => request('/safety/install-script-policy', {
    method: 'PUT',
    body: JSON.stringify({
      block_all: blockAll
    })
  }),
  addInstallScriptAllowlist: (pkg, ecosystem, reason = '') => request('/safety/install-script-allowlist', {
    method: 'POST',
    body: JSON.stringify({
      package: pkg,
      ecosystem,
      reason
    })
  }),
  removeInstallScriptAllowlist: id => request(`/safety/install-script-allowlist/${id}`, {
    method: 'DELETE'
  }),
  getSafetyProposals: workspaceId => request(`/safety/proposals${workspaceId ? `?workspace_id=${workspaceId}` : ''}`),
  acceptSafetyProposal: (id, data) => request(`/safety/proposals/${id}/accept`, {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  dismissSafetyProposal: id => request(`/safety/proposals/${id}/dismiss`, {
    method: 'POST'
  }),
  getScriptApprovals: workspaceId => request(`/safety/script-approvals${workspaceId ? `?workspace_id=${workspaceId}` : ''}`),
  deleteScriptApproval: id => request(`/safety/script-approvals/${id}`, {
    method: 'DELETE'
  }),
  getPluginRegistries: () => request('/plugins/registries'),
  addPluginRegistry: data => request('/plugins/registries', {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  updatePluginRegistry: (id, data) => request(`/plugins/registries/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  }),
  deletePluginRegistry: id => request(`/plugins/registries/${id}`, {
    method: 'DELETE'
  }),
  syncPluginRegistry: id => request(`/plugins/registries/${id}/sync`, {
    method: 'POST'
  }),
  syncAllPluginRegistries: () => request('/plugins/registries/sync', {
    method: 'POST'
  }),
  getPlugins: ({
    installed,
    registry
  } = {}) => {
    const params = [];
    if (installed) params.push('installed=1');
    if (registry) params.push(`registry=${encodeURIComponent(registry)}`);
    return request(`/plugins${params.length ? '?' + params.join('&') : ''}`);
  },
  getPlugin: id => request(`/plugins/${id}`),
  installPlugin: (id, opts = {}) => request(`/plugins/${id}/install`, {
    method: 'POST',
    body: JSON.stringify(opts)
  }),
  uninstallPlugin: id => request(`/plugins/${id}`, {
    method: 'DELETE'
  }),
  getSessionPluginComponents: sessionId => request(`/sessions/${sessionId}/plugin-components`),
  setSessionPluginComponents: (sessionId, componentIds) => request(`/sessions/${sessionId}/plugin-components`, {
    method: 'PUT',
    body: JSON.stringify({
      component_ids: componentIds
    })
  }),
  getAccounts: () => request('/accounts'),
  createAccount: data => request('/accounts', {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  updateAccount: (id, data) => request(`/accounts/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  }),
  deleteAccount: id => request(`/accounts/${id}`, {
    method: 'DELETE'
  }),
  testAccount: id => request(`/accounts/${id}/test`, {
    method: 'POST'
  }),
  openAccountBrowser: (id, opts = {}) => {
    const body = typeof opts === 'string' ? {
      url: opts
    } : opts || {};
    return request(`/accounts/${id}/open-browser`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
  },
  openNextAccount: (opts = {}) => {
    const body = typeof opts === 'string' ? {
      url: opts
    } : opts || {};
    return request('/accounts/open-next', {
      method: 'POST',
      body: JSON.stringify(body)
    });
  },
  getPermissionModeApply: (sessionId) => request(`/sessions/${sessionId}/permission-mode/apply`),
  applyPermissionModeNow: (sessionId) => request(`/sessions/${sessionId}/permission-mode/apply-now`, {
    method: 'POST'
  }),
  getLaunchApply: (sessionId) => request(`/sessions/${sessionId}/launch/apply`),
  // One restart applies every pending launch change (perms, model, effort).
  applyLaunchNow: (sessionId) => request(`/sessions/${sessionId}/launch/apply-now`, {
    method: 'POST'
  }),
  restartWithAccount: (sessionId, accountId) => request(`/sessions/${sessionId}/restart-with-account`, {
    method: 'POST',
    body: JSON.stringify({
      account_id: accountId
    })
  }),
  confirmSessionQuota: (sessionId, accountId, resetUnix = null) => request(`/sessions/${sessionId}/confirm-quota`, {
    method: 'POST',
    body: JSON.stringify({
      account_id: accountId,
      reset_unix: resetUnix
    })
  }),
  setupBrowser: (id, cliType, opts = {}) => request(`/accounts/${id}/setup-browser`, {
    method: 'POST',
    body: JSON.stringify({
      cli_type: cliType || undefined,
      driver: opts.driver || undefined
    })
  }),
  getAuthStatus: (id, cliType) => request(`/accounts/${id}/auth-status${cliType ? `?cli_type=${encodeURIComponent(cliType)}` : ''}`),
  detectBrowsers: () => request('/browser/detect'),
  popOutSession: sessionId => request(`/sessions/${sessionId}/pop-out`, {
    method: 'POST'
  }),
  getPeerMessages: (workspaceId, params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/workspaces/${workspaceId}/peer-messages${qs ? '?' + qs : ''}`);
  },
  postPeerMessage: (workspaceId, data) => request(`/workspaces/${workspaceId}/peer-messages`, {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  markPeerMessageRead: (id, sessionId) => request(`/peer-messages/${id}/read`, {
    method: 'PUT',
    body: JSON.stringify({
      session_id: sessionId
    })
  }),
  getSessionDigest: sessionId => request(`/sessions/${sessionId}/digest`),
  updateSessionDigest: (sessionId, data) => request(`/sessions/${sessionId}/digest`, {
    method: 'PUT',
    body: JSON.stringify(data)
  }),
  routeTask: (taskId, data = {}) => request(`/tasks/${taskId}/route`, {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  requestCapabilityHandoff: (data = {}) => request('/capabilities/handoff', {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  uploadSessionAttachment: (sessionId, formData) => {
    return fetch(`${apiBase()}/sessions/${sessionId}/attachments`, {
      method: 'POST',
      body: formData
    }).then(async res => {
      let body = null;
      try {
        body = await res.json();
      } catch {}
      if (!res.ok) {
        throw new ApiError(body?.error || body?.message || `HTTP ${res.status}`, {
          status: res.status,
          body
        });
      }
      return body;
    });
  },
  listSessionAttachments: sessionId => request(`/sessions/${sessionId}/attachments`),
  getCanvasContext: (workspaceId, canvasId) => request(`/workspaces/${workspaceId}/canvas/${encodeURIComponent(canvasId)}/context`),
  annotateCanvas: (workspaceId, canvasId, body) => request(`/workspaces/${workspaceId}/canvas/${encodeURIComponent(canvasId)}/annotate`, {
    method: 'POST',
    body: JSON.stringify(body)
  }),
  deleteCanvasAnnotation: (workspaceId, canvasId, annotationId) => request(`/workspaces/${workspaceId}/canvas/${encodeURIComponent(canvasId)}/annotations/${encodeURIComponent(annotationId)}`, {
    method: 'DELETE'
  }),
  getRecentFileActivity: (workspaceId, params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/workspaces/${workspaceId}/file-activity${qs ? '?' + qs : ''}`);
  },
  getFileActivity: (workspaceId, filePath) => request(`/workspaces/${workspaceId}/file-activity/file?path=${encodeURIComponent(filePath)}`),
  listMemoryEntries: (workspaceId, types, sourceCli) => {
    const params = new URLSearchParams();
    if (workspaceId) params.set('workspace', workspaceId);
    if (types) params.set('types', types);
    if (sourceCli) params.set('source_cli', sourceCli);
    return request(`/memory?${params}`);
  },
  createMemoryEntry: data => request('/memory', {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  autofillVision: (transcript, opts = {}) => request('/vision/autofill', {
    method: 'POST',
    body: JSON.stringify({
      transcript,
      ...opts
    })
  }),
  updateMemoryEntry: (id, data) => request(`/memory/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  }),
  deleteMemoryEntry: id => request(`/memory/${id}`, {
    method: 'DELETE'
  }),
  searchMemoryEntries: (query, workspaceId, types) => {
    const params = new URLSearchParams({
      q: query
    });
    if (workspaceId) params.set('workspace', workspaceId);
    if (types) params.set('types', types);
    return request(`/memory/search?${params}`);
  },
  importMemoryFromCli: (workspaceId, options = {}) => request('/memory/import', {
    method: 'POST',
    body: JSON.stringify({
      workspace_id: workspaceId,
      consent: options.consent === true
    })
  }),
  getMemoryPrompt: workspaceId => request(`/memory/prompt${workspaceId ? '?workspace=' + workspaceId : ''}`),
  getWorkspaceMemory: (workspaceId, params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/workspaces/${workspaceId}/memory${qs ? '?' + qs : ''}`);
  },
  updateWorkspaceMemory: (workspaceId, content) => request(`/workspaces/${workspaceId}/memory`, {
    method: 'PUT',
    body: JSON.stringify({
      content
    })
  }),
  syncWorkspaceMemory: (workspaceId, sourceCli, options = {}) => request(`/workspaces/${workspaceId}/memory/sync`, {
    method: 'POST',
    body: JSON.stringify({
      ...(sourceCli ? {
        source_cli: sourceCli
      } : {}),
      consent: options.consent === true
    })
  }),
  getWorkspaceMemoryDiff: (workspaceId, options = {}) => request(`/workspaces/${workspaceId}/memory/diff${options.consent === true ? '?consent=true' : ''}`),
  resolveWorkspaceMemory: (workspaceId, resolvedContent, pushTo, options = {}) => request(`/workspaces/${workspaceId}/memory/resolve`, {
    method: 'POST',
    body: JSON.stringify({
      resolved_content: resolvedContent,
      push_to: pushTo,
      consent: options.consent === true
    })
  }),
  getWorkspaceMemorySettings: workspaceId => request(`/workspaces/${workspaceId}/memory/settings`),
  updateWorkspaceMemorySettings: (workspaceId, settings) => request(`/workspaces/${workspaceId}/memory/settings`, {
    method: 'PUT',
    body: JSON.stringify(settings)
  }),
  getWorkspaceAutoMemory: workspaceId => request(`/workspaces/${workspaceId}/memory/auto`),
  getObservatoryFindings: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/observatory/findings${qs ? '?' + qs : ''}`);
  },
  updateObservatoryFinding: (id, data) => request(`/observatory/findings/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  }),
  deleteObservatoryFinding: id => request(`/observatory/findings/${id}`, {
    method: 'DELETE'
  }),
  promoteObservatoryFinding: (id, workspaceId) => request(`/observatory/findings/${id}/promote`, {
    method: 'POST',
    body: JSON.stringify({
      workspace_id: workspaceId
    })
  }),
  getObservatoryScans: () => request('/observatory/scans'),
  triggerObservatoryScan: data => request('/observatory/scan', {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  getObservatorySettings: workspaceId => request(`/observatory/settings?workspace_id=${workspaceId}`),
  updateObservatorySettings: data => request('/observatory/settings', {
    method: 'PUT',
    body: JSON.stringify(data)
  }),
  getObservatoryApiKeys: () => request('/observatory/api-keys'),
  setObservatoryApiKey: (name, value) => request('/observatory/api-keys', {
    method: 'PUT',
    body: JSON.stringify({
      name,
      value
    })
  }),
  testObservatoryApiKey: name => request('/observatory/api-keys/test', {
    method: 'POST',
    body: JSON.stringify({
      name
    })
  }),
  createObservatorist: workspaceId => request(`/workspaces/${workspaceId}/observatorist`, {
    method: 'POST'
  }),
  getObservatoryProfile: (workspaceId, scope = 'workspace') => {
    const qs = new URLSearchParams({
      scope,
      ...(workspaceId ? {
        workspace_id: workspaceId
      } : {})
    }).toString();
    return request(`/observatory/profile?${qs}`);
  },
  regenerateObservatoryProfile: workspaceId => request('/observatory/profile/regenerate', {
    method: 'POST',
    body: JSON.stringify({
      workspace_id: workspaceId
    })
  }),
  updateObservatoryProfile: (workspaceId, profile, scope = 'workspace') => request('/observatory/profile', {
    method: 'PUT',
    body: JSON.stringify({
      workspace_id: workspaceId,
      profile,
      scope
    })
  }),
  recalibrateObservatoryProfile: workspaceId => request('/observatory/profile/recalibrate', {
    method: 'POST',
    body: JSON.stringify({
      workspace_id: workspaceId
    })
  }),
  listObservatorySearchTargets: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/observatory/search-targets${qs ? '?' + qs : ''}`);
  },
  addObservatorySearchTarget: data => request('/observatory/search-targets', {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  updateObservatorySearchTarget: (id, data) => request(`/observatory/search-targets/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  }),
  deleteObservatorySearchTarget: id => request(`/observatory/search-targets/${id}`, {
    method: 'DELETE'
  }),
  planObservatorySearchTargets: (workspaceId, source, scope = 'workspace') => request('/observatory/search-targets/plan', {
    method: 'POST',
    body: JSON.stringify({
      workspace_id: workspaceId,
      source,
      scope
    })
  }),
  triggerObservatorySmartScan: data => request('/observatory/scan/smart', {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  listObservatoryInsights: (workspaceId, type, scope) => {
    const qs = new URLSearchParams({
      ...(workspaceId ? {
        workspace_id: workspaceId
      } : {}),
      ...(type ? {
        type
      } : {}),
      ...(scope ? {
        scope
      } : {})
    }).toString();
    return request(`/observatory/insights?${qs}`);
  },
  upsertObservatoryInsight: data => request('/observatory/insights', {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  updateObservatoryInsight: (id, data) => request(`/observatory/insights/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  }),
  deleteObservatoryInsight: id => request(`/observatory/insights/${id}`, {
    method: 'DELETE'
  }),
  getApiKeys: () => request('/api-keys'),
  saveApiKey: (name, value) => request('/api-keys', {
    method: 'PUT',
    body: JSON.stringify({
      name,
      value
    })
  }),
  testApiKey: name => request('/api-keys/test', {
    method: 'POST',
    body: JSON.stringify({
      name
    })
  }),
  createInvite: body => request('/invite/create', {
    method: 'POST',
    body: JSON.stringify(body)
  }),
  listInvites: () => request('/invites'),
  revokeInvite: id => request(`/invite/${id}/revoke`, {
    method: 'POST'
  }),
  redeemInvite: token => request('/invite/redeem', {
    method: 'POST',
    body: JSON.stringify({
      token
    })
  }),
  whoami: () => request('/whoami'),
  listAuthSessions: () => request('/sessions/auth'),
  revokeAuthSession: id => request(`/sessions/auth/${id}/revoke`, {
    method: 'POST'
  }),
  logout: () => request('/auth/logout', {
    method: 'POST'
  }),
  getRuntimeStatus: () => request('/runtime/status', {
    cache: 'no-store'
  }),
  startTunnel: () => request('/runtime/tunnel/start', {
    method: 'POST'
  }),
  stopTunnel: () => request('/runtime/tunnel/stop', {
    method: 'POST'
  }),
  setMultiplayer: enabled => request('/runtime/multiplayer', {
    method: 'POST',
    body: JSON.stringify({
      enabled: !!enabled
    })
  }),
  setMode: mode => request('/runtime/mode', {
    method: 'POST',
    body: JSON.stringify({
      mode
    })
  }),
  listAuditLog: ({
    actor_id,
    actor_kind,
    since,
    path_prefix,
    limit
  } = {}) => {
    const qs = new URLSearchParams();
    if (actor_id) qs.set('actor_id', actor_id);
    if (actor_kind) qs.set('actor_kind', actor_kind);
    if (since) qs.set('since', since);
    if (path_prefix) qs.set('path_prefix', path_prefix);
    if (limit) qs.set('limit', String(limit));
    const q = qs.toString();
    return request(`/audit${q ? `?${q}` : ''}`);
  },
  getCatchup: ({
    since,
    until,
    workspace_id,
    limit,
    llm,
    model
  } = {}) => {
    const qs = new URLSearchParams();
    if (since) qs.set('since', since);
    if (until) qs.set('until', until);
    if (workspace_id) qs.set('workspace_id', workspace_id);
    if (limit) qs.set('limit', String(limit));
    if (llm === false) qs.set('llm', 'false');
    if (model) qs.set('model', model);
    const s = qs.toString();
    return request(`/catchup${s ? `?${s}` : ''}`);
  },
  catchupChat: (digest, messages) => request('/catchup/chat', {
    method: 'POST',
    body: JSON.stringify({
      digest,
      messages
    })
  }),
  // persist: false keeps a read-only poll from rewriting sessions.total_cost_usd.
  getCost: ({
    workspace_id,
    since,
    until,
    persist
  } = {}) => {
    const qs = new URLSearchParams();
    if (workspace_id) qs.set('workspace_id', workspace_id);
    if (since) qs.set('since', since);
    if (until) qs.set('until', until);
    if (persist === false) qs.set('persist', '0');
    const s = qs.toString();
    return request(`/cost${s ? `?${s}` : ''}`);
  },
  phoneStatus: () => request('/phone/status'),
  phoneSetup: choices => request('/phone/setup', { method: 'POST', body: JSON.stringify(choices) }),
  phoneAvailabilityStart: () => request('/phone/availability/start', { method: 'POST' }),
  phoneAvailabilityStop: () => request('/phone/availability/stop', { method: 'POST' }),
  phoneAvailabilityApprove: () => request('/phone/availability/approval', { method: 'POST' }),
  phonePairStart: () => request('/phone/pair/start', { method: 'POST' }),
  phonePairCancel: () => request('/phone/pair/cancel', { method: 'POST' }),
  phoneDevices: () => request('/phone/devices'),
  phoneRevokeDevice: id => request(`/phone/devices/${encodeURIComponent(id)}/revoke`, { method: 'POST' }),
  phoneSetPin: (pin, idleMinutes) => request('/phone/pin', {
    method: 'POST',
    body: JSON.stringify({ pin, idle_minutes: idleMinutes })
  }),
  phoneClearPin: () => request('/phone/pin', { method: 'DELETE' }),
  phoneUnlock: pin => request('/phone/unlock', { method: 'POST', body: JSON.stringify({ pin }) }),
  phoneLock: () => request('/phone/lock', { method: 'POST' }),
  phoneApnsStatus: () => request('/phone/apns'),
  phoneApnsSave: ({ keyP8, keyId, teamId, bundleId }) => request('/phone/apns', {
    method: 'POST',
    body: JSON.stringify({ key_p8: keyP8 || null, key_id: keyId, team_id: teamId, bundle_id: bundleId })
  }),
  phoneApnsClear: () => request('/phone/apns', { method: 'DELETE' }),
  phoneApnsTest: deviceId => request('/phone/apns/test', {
    method: 'POST',
    body: JSON.stringify(deviceId ? { device_id: deviceId } : {})
  }),
  pushVapidPubkey: () => request('/push/vapid-pubkey'),
  subscribePush: subscription => request('/push/subscribe', {
    method: 'POST',
    body: JSON.stringify(subscription)
  }),
  unsubscribePush: endpoint => request('/push/unsubscribe', {
    method: 'POST',
    body: JSON.stringify({
      endpoint
    })
  }),
  secureProvision: (sessionId, scope, ttlMinutes) => request('/secure/provision', {
    method: 'POST',
    body: JSON.stringify({
      session_id: sessionId,
      scope,
      ttl_minutes: ttlMinutes
    })
  }),
  secureGetRun: sessionId => request(`/secure/run?session_id=${encodeURIComponent(sessionId)}`),
  secureTeardown: runId => request('/secure/teardown', {
    method: 'POST',
    body: JSON.stringify({
      run_id: runId
    })
  }),
  secureKill: runId => request('/secure/kill', {
    method: 'POST',
    body: JSON.stringify({
      run_id: runId
    })
  })
};
export function isLocalOrigin() {
  if (typeof window === 'undefined') return true;
  const h = window.location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '';
}
export function localPreviewUrl(port, path = '/') {
  const p = path.startsWith('/') ? path : `/${path}`;
  if (isLocalOrigin()) {
    return `http://127.0.0.1:${port}${p}`;
  }
  return `${window.location.origin}/preview/${port}${p}`;
}
export function rewriteLocalPreviewUrl(url) {
  if (!url || isLocalOrigin()) return url;
  const m = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)(\/.*)?$/i.exec(url);
  if (!m) return url;
  const port = parseInt(m[1], 10);
  const path = m[2] || '/';
  return localPreviewUrl(port, path);
}
export const demoApi = {
  status: wsId => request(`/workspaces/${wsId}/demo`),
  start: (wsId, body = {}) => request(`/workspaces/${wsId}/demo/start`, {
    method: 'POST',
    body: JSON.stringify(body)
  }),
  stop: wsId => request(`/workspaces/${wsId}/demo/stop`, {
    method: 'POST'
  }),
  pullLatest: wsId => request(`/workspaces/${wsId}/demo/pull-latest`, {
    method: 'POST'
  }),
  log: wsId => request(`/workspaces/${wsId}/demo/log`),
  list: () => request('/demos')
};
export const portApi = {
  list: (wsId, opts = {}) => {
    const params = new URLSearchParams();
    if (opts.scan) params.set('scan', '1');
    if (opts.start_port) params.set('start_port', String(opts.start_port));
    if (opts.end_port) params.set('end_port', String(opts.end_port));
    const qs = params.toString();
    return request(`/workspaces/${wsId}/ports${qs ? `?${qs}` : ''}`);
  },
  lease: (wsId, body = {}) => request(`/workspaces/${wsId}/ports/lease`, {
    method: 'POST',
    body: JSON.stringify(body)
  }),
  heartbeat: (leaseId, body = {}) => request(`/ports/${leaseId}/heartbeat`, {
    method: 'POST',
    body: JSON.stringify(body)
  }),
  release: leaseId => request(`/ports/${leaseId}`, {
    method: 'DELETE'
  }),
  registerPreview: (wsId, body = {}) => request(`/workspaces/${wsId}/previews/register`, {
    method: 'POST',
    body: JSON.stringify(body)
  })
};
export const runtimeEnvApi = {
  get: wsId => request(`/workspaces/${wsId}/runtime-env`)
};
