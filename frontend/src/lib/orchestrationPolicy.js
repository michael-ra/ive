export const ORCHESTRATION_ROLE_OPTIONS = [
  {
    id: 'brain',
    label: 'Brain / Router',
    hint: 'Fast supervisor that classifies tasks, chooses pipelines, and monitors state.',
    fallbackRole: 'commander',
  },
  {
    id: 'summary',
    label: 'Summary / Memory',
    hint: 'Cheap model for session digests, memory candidates, and summaries.',
    fallbackRole: 'worker',
  },
  {
    id: 'brainstormer',
    label: 'Product Intake / Brainstormer',
    hint: 'Explores ideas and shapes candidate backlog tickets; does not execute work.',
    fallbackRole: 'commander',
    fallbackHint: 'Falls back to Planner candidates, then Brain / Router candidates, then CLI defaults.',
    fallbackPolicyRoles: ['planner', 'brain'],
  },
  {
    id: 'planner',
    label: 'Planner',
    hint: 'Deep decomposition for vague or complex tickets.',
    fallbackRole: 'commander',
  },
  {
    id: 'plan_critic',
    label: 'Plan Reviewer',
    hint: 'Reviews plans before implementation starts.',
    fallbackRole: 'commander',
  },
  {
    id: 'default_worker',
    label: 'Default Worker',
    hint: 'Normal implementation work.',
    fallbackRole: 'worker',
  },
  {
    id: 'cheap_worker',
    label: 'Cheap Worker',
    hint: 'Small copy, CSS, and low-risk edits.',
    fallbackRole: 'worker',
  },
  {
    id: 'strong_worker',
    label: 'Strong Worker',
    hint: 'High-risk implementation and repeated failures.',
    fallbackRole: 'worker',
  },
  {
    id: 'code_reviewer',
    label: 'Code Reviewer',
    hint: 'Audits diffs after implementation.',
    fallbackRole: 'commander',
  },
  {
    id: 'tester',
    label: 'Tester',
    hint: 'Verification stages and temporary test workers.',
    fallbackRole: 'tester',
  },
  {
    id: 'documentor',
    label: 'Documentor',
    hint: 'Documentation and screenshot update stages.',
    fallbackRole: 'documentor',
  },
]

const DEFAULT_POLICY = {
  roles: {},
  routing_instructions: '',
  reuse_instructions: '',
  summary_mode: 'hybrid',
}

function normalizeCandidate(cand) {
  if (!cand || typeof cand !== 'object') return null
  const cli_type = (cand.cli_type || '').trim()
  const model = (cand.model || '').trim()
  if (!cli_type && !model) return null
  const priority = Number.isFinite(Number(cand.priority)) ? Math.trunc(Number(cand.priority)) : 1
  return { cli_type, model, priority }
}

function normalizeRoleCandidates(roleCfg) {
  if (!roleCfg || typeof roleCfg !== 'object') return []
  if (Array.isArray(roleCfg.candidates)) {
    return roleCfg.candidates.map(normalizeCandidate).filter(Boolean)
  }
  // Legacy {cli_type, model} → single priority=1 candidate.
  const legacy = normalizeCandidate(roleCfg)
  return legacy ? [legacy] : []
}

export function parseOrchestrationPolicy(raw) {
  let parsed = raw
  if (typeof raw === 'string') {
    try {
      parsed = raw.trim() ? JSON.parse(raw) : {}
    } catch {
      parsed = {}
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {}

  const roles = {}
  for (const role of ORCHESTRATION_ROLE_OPTIONS) {
    roles[role.id] = { candidates: normalizeRoleCandidates(parsed.roles?.[role.id]) }
  }

  return {
    ...DEFAULT_POLICY,
    ...parsed,
    roles,
    routing_instructions: parsed.routing_instructions || '',
    reuse_instructions: parsed.reuse_instructions || '',
    summary_mode: parsed.summary_mode || 'hybrid',
  }
}

export function serializeOrchestrationPolicy(policy) {
  const normalized = parseOrchestrationPolicy(policy)
  return JSON.stringify(normalized)
}

export function defaultPolicyRoleForSessionType(sessionType) {
  if (sessionType === 'commander') return 'brain'
  if (sessionType === 'brainstormer') return 'brainstormer'
  if (sessionType === 'planner') return 'planner'
  if (sessionType === 'tester' || sessionType === 'test_worker') return 'tester'
  if (sessionType === 'documentor') return 'documentor'
  return 'default_worker'
}

function roleCandidates(policy, roleId, seen = new Set()) {
  if (seen.has(roleId)) return []
  seen.add(roleId)
  const parsed = parseOrchestrationPolicy(policy)
  const explicit = parsed.roles?.[roleId]?.candidates || []
  if (explicit.length) return explicit

  const role = ORCHESTRATION_ROLE_OPTIONS.find((r) => r.id === roleId)
  for (const fallbackRole of role?.fallbackPolicyRoles || []) {
    const fallback = roleCandidates(parsed, fallbackRole, seen)
    if (fallback.length) return fallback
  }
  return []
}

// Mirrors backend role_model(): pick the highest-priority candidate, breaking
// ties uniformly at random. Returns {cli_type, model} or null.
export function pickRoleCandidate(policy, roleId) {
  const candidates = roleCandidates(policy, roleId)
  if (!candidates.length) return null
  const top = candidates.reduce((m, c) => Math.max(m, c.priority), -Infinity)
  const tier = candidates.filter((c) => c.priority === top)
  return tier[Math.floor(Math.random() * tier.length)]
}

// Back-compat shim for UI that just wants to show "the default" for a role.
// Deterministic (first candidate of the top-priority tier) so dropdowns don't
// flip on every render — pickRoleCandidate is the random one used at runtime.
export function getPolicyRoleConfig(policy, roleId) {
  const candidates = roleCandidates(policy, roleId)
  if (!candidates.length) return { cli_type: '', model: '' }
  const top = candidates.reduce((m, c) => Math.max(m, c.priority), -Infinity)
  const first = candidates.find((c) => c.priority === top)
  return { cli_type: first.cli_type, model: first.model }
}
