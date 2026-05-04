import json
import uuid

import aiosqlite
from config import (
    DATA_DIR, DB_PATH, DEFAULT_REGISTRIES, MCP_SERVER_PATH,
    WORKER_MCP_SERVER_PATH, DEEP_RESEARCH_MCP_PATH, DEEP_RESEARCH_SKILL_PATH,
    DOCUMENTOR_MCP_SERVER_PATH,
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    color TEXT,
    human_oversight TEXT DEFAULT 'approve_plans',
    tester_mode TEXT DEFAULT 'direct',
    research_model TEXT,
    research_llm_url TEXT,
    preview_url TEXT,
    default_worktree INTEGER DEFAULT 0,
    output_style TEXT,
    knowledge_context_limit INTEGER DEFAULT 3000,
    order_index INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT,
    model TEXT DEFAULT 'sonnet',
    permission_mode TEXT DEFAULT 'default',
    effort TEXT DEFAULT 'high',
    budget_usd REAL,
    system_prompt TEXT,
    allowed_tools TEXT,
    disallowed_tools TEXT,
    add_dirs TEXT,
    agent TEXT,
    worktree INTEGER DEFAULT 0,
    mcp_config TEXT,
    turn_count INTEGER DEFAULT 0,
    total_cost_usd REAL DEFAULT 0,
    status TEXT DEFAULT 'idle',
    is_imported INTEGER DEFAULT 0,
    session_type TEXT DEFAULT 'worker',
    parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    scratchpad TEXT,
    account_id TEXT REFERENCES accounts(id),
    native_session_id TEXT,
    native_slug TEXT,
    auto_approve_mcp INTEGER DEFAULT 0,
    cli_type TEXT DEFAULT 'claude',
    output_style TEXT,
    order_index INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    last_active_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT,
    thinking TEXT,
    tool_calls TEXT,
    cost_usd REAL DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT DEFAULT 'General',
    content TEXT NOT NULL,
    variables TEXT,
    tags TEXT,
    usage_count INTEGER DEFAULT 0,
    pinned INTEGER DEFAULT 0,
    is_quickaction INTEGER DEFAULT 0,
    quickaction_order INTEGER DEFAULT 0,
    icon TEXT,
    color TEXT,
    source_type TEXT,
    source_url TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS guidelines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    is_default INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS workspace_guidelines (
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
    guideline_id TEXT REFERENCES guidelines(id) ON DELETE CASCADE,
    PRIMARY KEY (workspace_id, guideline_id)
);

CREATE TABLE IF NOT EXISTS session_guidelines (
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    guideline_id TEXT REFERENCES guidelines(id) ON DELETE CASCADE,
    PRIMARY KEY (session_id, guideline_id)
);

CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    server_name TEXT NOT NULL UNIQUE,
    description TEXT,
    server_type TEXT DEFAULT 'stdio',
    command TEXT NOT NULL,
    args TEXT,
    env TEXT,
    auto_approve INTEGER DEFAULT 0,
    default_enabled INTEGER DEFAULT 0,
    is_builtin INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS session_mcp_servers (
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    mcp_server_id TEXT REFERENCES mcp_servers(id) ON DELETE CASCADE,
    auto_approve_override INTEGER,
    PRIMARY KEY (session_id, mcp_server_id)
);

CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    model TEXT,
    permission_mode TEXT,
    effort TEXT,
    budget_usd REAL,
    system_prompt TEXT,
    allowed_tools TEXT,
    disallowed_tools TEXT,
    guideline_ids TEXT,
    conversation_turns TEXT,
    cli_type TEXT DEFAULT 'claude',
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    acceptance_criteria TEXT,
    status TEXT DEFAULT 'backlog',
    priority INTEGER DEFAULT 0,
    sort_order REAL DEFAULT 0,
    assigned_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    commander_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    labels TEXT,
    result_summary TEXT,
    scratchpad TEXT,
    plan_first INTEGER DEFAULT 0,
    auto_approve_plan INTEGER DEFAULT 0,
    ralph_loop INTEGER DEFAULT 0,
    ralph_iteration INTEGER DEFAULT 0,
    ralph_phase TEXT,
    deep_research INTEGER DEFAULT 0,
    test_with_agent INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT
);

CREATE TABLE IF NOT EXISTS test_queue (
    id TEXT PRIMARY KEY,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
    task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    acceptance_criteria TEXT,
    status TEXT DEFAULT 'queued',
    assigned_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    result_summary TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT
);

CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    actor TEXT,
    old_value TEXT,
    new_value TEXT,
    message TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS output_captures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    capture_type TEXT NOT NULL,
    tool_name TEXT,
    content TEXT,
    raw_text TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS research_entries (
    id TEXT PRIMARY KEY,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
    topic TEXT NOT NULL,
    query TEXT,
    feature_tag TEXT,
    status TEXT DEFAULT 'pending',
    findings_summary TEXT,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS research_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id TEXT REFERENCES research_entries(id) ON DELETE CASCADE,
    url TEXT,
    title TEXT,
    content_summary TEXT,
    raw_content TEXT,
    relevance_score REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'api_key',
    api_key TEXT,
    is_default INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    last_used_at TEXT,
    quota_reset_at TEXT,
    browser_path TEXT,
    chrome_profile TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS grid_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cols INTEGER NOT NULL DEFAULT 3,
    cells TEXT NOT NULL DEFAULT '[]',              -- JSON: [{ id, col, row, colSpan, rowSpan }]
    cell_assignments TEXT NOT NULL DEFAULT '{}',   -- JSON: { [cellId]: sessionId }
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- ─── Tab groups ─────────────────────────────────────────────────────────
-- Named sets of session IDs per workspace, allowing one-click switching
-- between different tab arrangements.

CREATE TABLE IF NOT EXISTS tab_groups (
    id TEXT PRIMARY KEY,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    session_ids TEXT NOT NULL DEFAULT '[]',   -- JSON array of session IDs
    is_active INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- ─── Plugin marketplace ──────────────────────────────────────────────────
-- Discovery servers ("registries") publish a JSON index of plugins. Multiple
-- registries can be configured (apt-style sources). The built-in default
-- registry is seeded on first run and can be disabled but not deleted.

CREATE TABLE IF NOT EXISTS plugin_registries (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    enabled INTEGER DEFAULT 1,
    is_builtin INTEGER DEFAULT 0,        -- 1 = preconfigured, can disable but not delete
    last_synced_at TEXT,
    last_sync_status TEXT,                -- 'ok', 'error', 'never'
    last_sync_error TEXT,
    plugin_count INTEGER DEFAULT 0,
    order_index INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);

-- A plugin row exists for two reasons:
--   • installed=1 → the plugin lives locally and can be attached to sessions
--   • installed=0 → catalog entry from a registry sync, browsable but not installed
-- Catalog entries are wiped + re-populated on each registry sync; installed
-- entries are preserved across syncs (user data).
CREATE TABLE IF NOT EXISTS plugins (
    id TEXT PRIMARY KEY,                  -- plugin's own id from registry
    registry_id TEXT REFERENCES plugin_registries(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    version TEXT,
    description TEXT,
    author TEXT,
    license TEXT,
    source_url TEXT,                      -- upstream (GitHub, etc.)
    source_format TEXT,                   -- 'skill_md', 'cursorrules', 'claude_md', 'gemini_md', etc.
    categories TEXT,                      -- JSON array
    tags TEXT,                            -- JSON array
    security_tier INTEGER DEFAULT 0,      -- 0=text-only, 1=sandboxed, 2=extended, 3=unverified
    contains_scripts INTEGER DEFAULT 0,
    rating REAL,
    install_count INTEGER DEFAULT 0,
    package_url TEXT,                     -- where the full package can be downloaded
    package_data TEXT,                    -- JSON: full plugin.yaml content (after install)
    checksum TEXT,
    installed INTEGER DEFAULT 0,
    installed_at TEXT,
    scripts_approved INTEGER DEFAULT 0,
    skipped_components TEXT,              -- JSON array of component ids the user opted out of
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plugin_components (
    id TEXT PRIMARY KEY,
    plugin_id TEXT REFERENCES plugins(id) ON DELETE CASCADE,
    type TEXT NOT NULL,                   -- 'guideline' or 'script'
    name TEXT NOT NULL,
    description TEXT,
    content TEXT,                         -- guideline text OR script source
    activation TEXT DEFAULT 'always',     -- 'always' (system prompt) or 'on_demand' (disk skill)
    trigger TEXT,                         -- for scripts: session_start, prompt_submit, etc.
    permissions TEXT,                     -- JSON array
    ai_explanation TEXT,                  -- generated on-demand for scripts
    risk_level TEXT,                      -- 'low', 'medium', 'high'
    skippable INTEGER DEFAULT 1,
    order_index INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Bridge: which plugin components are active on which sessions.
-- Mirrors session_guidelines but at the component granularity so users can
-- enable a guideline from a plugin without enabling its scripts.
CREATE TABLE IF NOT EXISTS session_plugin_components (
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    component_id TEXT REFERENCES plugin_components(id) ON DELETE CASCADE,
    PRIMARY KEY (session_id, component_id)
);

-- ─── Prompt cascades ──────────────────────────────────────────────────
-- An ordered sequence of prompts sent to a session one-by-one, each
-- waiting for the session to finish before sending the next. Optionally
-- loops until the user interrupts. Like Ralph Loop but across multiple
-- distinct prompts rather than one self-iterating prompt.
CREATE TABLE IF NOT EXISTS cascades (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    steps TEXT NOT NULL DEFAULT '[]',      -- JSON array of prompt strings
    loop INTEGER DEFAULT 0,
    auto_approve INTEGER DEFAULT 0,        -- restart session in auto-approve mode
    bypass_permissions INTEGER DEFAULT 0,  -- restart session with full bypass (dangerous)
    usage_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT
);

-- ─── Server-side cascade runs ────────────────────────────────────────
-- Tracks active cascade execution on the backend. The backend drives
-- step advancement (via hook idle detection), so cascades survive
-- browser disconnect and form the foundation for background session
-- automation.
CREATE TABLE IF NOT EXISTS cascade_runs (
    id TEXT PRIMARY KEY,
    cascade_id TEXT,                           -- optional ref to saved cascade
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'running',             -- running | paused | waiting_idle | completed | failed | stopped
    current_step INTEGER DEFAULT 0,
    iteration INTEGER DEFAULT 0,
    steps TEXT NOT NULL DEFAULT '[]',          -- JSON: resolved (substituted) prompt strings
    original_steps TEXT,                       -- JSON: unsubstituted for loop re-prompt
    loop INTEGER DEFAULT 0,
    auto_approve INTEGER DEFAULT 0,
    bypass_permissions INTEGER DEFAULT 0,
    auto_approve_plan INTEGER DEFAULT 0,
    variables TEXT DEFAULT '[]',               -- JSON: variable metadata
    variable_values TEXT DEFAULT '{}',         -- JSON: current variable values
    loop_reprompt INTEGER DEFAULT 0,
    error TEXT,
    started_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_cascade_runs_session
    ON cascade_runs(session_id, status);

-- ─── Memory entries (Commander-owned auto-memory) ─────────────────────
-- CLI-agnostic memory store. Commander is the source of truth; entries
-- are injected into ALL CLIs' system prompts at session start.  Claude's
-- native .claude/memory/*.md can be imported/exported but the DB is
-- canonical.  workspace_id=NULL means the entry is global.
CREATE TABLE IF NOT EXISTS memory_entries (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    description TEXT DEFAULT '',
    content TEXT NOT NULL,
    source_cli TEXT DEFAULT 'commander',
    tags TEXT DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_memory_entries_workspace
    ON memory_entries(workspace_id);
CREATE INDEX IF NOT EXISTS idx_memory_entries_type
    ON memory_entries(type);

-- ─── Memory sync ──────────────────────────────────────────────────────
-- Central memory store per workspace.  Commander is the hub; each CLI's
-- memory file (CLAUDE.md, GEMINI.md, ...) is a spoke.  provider_hashes
-- is a JSON dict keyed by cli_type so adding new CLIs needs no schema change.
CREATE TABLE IF NOT EXISTS workspace_memory (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'project',
    content TEXT NOT NULL DEFAULT '',
    provider_hashes TEXT NOT NULL DEFAULT '{}',
    settings TEXT NOT NULL DEFAULT '{}',
    last_synced_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(workspace_id, scope)
);

-- ─── Broadcast groups ────────────────────────────────────────────────
-- Named sets of session IDs for quick broadcast targeting. Users save
-- a selection of sessions as a group and recall it later from the
-- broadcast bar instead of re-picking sessions each time.
CREATE TABLE IF NOT EXISTS broadcast_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    session_ids TEXT NOT NULL DEFAULT '[]',   -- JSON array of session IDs
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- ─── App settings ─────────────────────────────────────────────────────
-- Generic key/value store for global Commander settings. Used today for
-- experimental feature flags (which the user must explicitly opt into);
-- reusable for any future app-wide config that doesn't fit the session or
-- workspace tables.
--
-- Values are stored as TEXT — callers are expected to JSON-encode complex
-- values and decode on read. Simple on/off flags use "on"/"off".
CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
);

-- ─── Commander event bus ─────────────────────────────────────────────
-- Audit log of every state change fired through the event bus. Every row
-- is one CommanderEvent emission with its payload. Used for:
--   • Activity feed UI
--   • Plugin subscription matching (future dispatch)
--   • Audit / debugging / replay
--   • Webhook delivery records
CREATE TABLE IF NOT EXISTS commander_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,                -- CommanderEvent value (e.g. "task_completed")
    source TEXT NOT NULL DEFAULT 'commander',-- where the event originated (commander|api|mcp|plugin|hook)
    payload TEXT,                            -- JSON-encoded event-specific data
    workspace_id TEXT,                       -- denormalized for fast filtering
    session_id TEXT,                         -- denormalized
    task_id TEXT,                            -- denormalized
    actor TEXT,                              -- "user" | "commander" | "plugin:<id>" | ...
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_commander_events_type
    ON commander_events(event_type);
CREATE INDEX IF NOT EXISTS idx_commander_events_created
    ON commander_events(created_at);
CREATE INDEX IF NOT EXISTS idx_commander_events_workspace
    ON commander_events(workspace_id);
CREATE INDEX IF NOT EXISTS idx_commander_events_task
    ON commander_events(task_id);
CREATE INDEX IF NOT EXISTS idx_commander_events_session
    ON commander_events(session_id);

-- ─── Event subscriptions (webhooks) ──────────────────────────────────
-- Users and plugins register subscriptions that fire a webhook when any
-- matching event is emitted. Events are matched by event_type (supports
-- CSV list) and optional workspace scoping.
--
-- Delivery is best-effort: failures are recorded in last_delivery_status
-- but never block the event emission.
CREATE TABLE IF NOT EXISTS event_subscriptions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    event_types TEXT NOT NULL,               -- CSV of CommanderEvent values or "*"
    workspace_id TEXT,                        -- optional scope
    delivery_type TEXT NOT NULL DEFAULT 'webhook',  -- webhook | plugin | log
    webhook_url TEXT,                         -- for delivery_type=webhook
    webhook_secret TEXT,                      -- optional HMAC signing secret
    plugin_id TEXT REFERENCES plugins(id) ON DELETE CASCADE,  -- for delivery_type=plugin
    enabled INTEGER DEFAULT 1,
    created_by TEXT,                          -- "user" | "plugin:<id>"
    delivery_count INTEGER DEFAULT 0,
    last_delivery_at TEXT,
    last_delivery_status TEXT,                -- ok | error | pending
    last_delivery_error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_event_subs_enabled
    ON event_subscriptions(enabled);

-- ─── W2W: Session digests ────────────────────────────────────────────
-- Each worker session maintains a living summary of what it's doing,
-- what files it's touched, key decisions, and discoveries. Files_touched
-- is auto-tracked by PostToolUse hooks on Edit/Write. The rest is updated
-- explicitly by the worker via MCP tool or the session idle hook.
CREATE TABLE IF NOT EXISTS session_digests (
    id TEXT PRIMARY KEY,
    session_id TEXT UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
    task_summary TEXT DEFAULT '',
    current_focus TEXT DEFAULT '',
    files_touched TEXT DEFAULT '[]',
    decisions TEXT DEFAULT '[]',
    discoveries TEXT DEFAULT '[]',
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_session_digests_workspace
    ON session_digests(workspace_id);

-- ─── W2W: Peer messages (bulletin board) ─────────────────────────────
-- Pull-based bulletin board for worker-to-worker communication. Workers
-- post messages tagged by topic/files/priority. No direct messaging —
-- all messages are workspace-scoped and filtered by relevance.
-- Priority levels (inspired by Myelin's OverlapLevel graduation):
--   info      = pull-only FYI, workers check when convenient
--   heads_up  = surfaced when worker goes idle (nudge)
--   blocking  = injected at next PostToolUse breakpoint
CREATE TABLE IF NOT EXISTS peer_messages (
    id TEXT PRIMARY KEY,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
    from_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    topic TEXT NOT NULL DEFAULT 'general',
    content TEXT NOT NULL,
    priority TEXT DEFAULT 'info',
    files TEXT DEFAULT '[]',
    read_by TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_peer_messages_workspace
    ON peer_messages(workspace_id, created_at);

-- ─── W2W: Workspace knowledge base ──────────────────────────────────
-- Living, worker-contributed codebase understanding. Workers contribute
-- discoveries via MCP tool; new sessions get relevant knowledge injected
-- into their system prompt. Inspired by Myelin's confidence/salience
-- scoring: confirmed_count tracks how many workers have validated an entry.
-- Categories: architecture, convention, gotcha, pattern, api, setup
CREATE TABLE IF NOT EXISTS workspace_knowledge (
    id TEXT PRIMARY KEY,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    content TEXT NOT NULL,
    scope TEXT DEFAULT '',
    contributed_by TEXT,
    confirmed_count INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_workspace_knowledge_workspace
    ON workspace_knowledge(workspace_id, category);

-- ─── Code Catalog: replace history (sidecar to workspace_knowledge) ──
-- When a code_catalog row is replaced (latest-write-wins), the prior
-- content snapshot lands here so the UI / audit views can show "this
-- entry was rewritten by session X at time Y, prior content was Z."
-- Confirmations don't write here; only true content disagreements.
CREATE TABLE IF NOT EXISTS code_catalog_history (
    id TEXT PRIMARY KEY,
    knowledge_id TEXT REFERENCES workspace_knowledge(id) ON DELETE CASCADE,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
    symbol_name TEXT,
    prior_content TEXT NOT NULL,
    prior_contributed_by TEXT,
    prior_confirmed_count INTEGER DEFAULT 1,
    replaced_by_session TEXT,
    replaced_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_code_catalog_history_knowledge
    ON code_catalog_history(knowledge_id);
CREATE INDEX IF NOT EXISTS idx_code_catalog_history_workspace
    ON code_catalog_history(workspace_id, replaced_at);

-- ─── W2W: File activity log ─────────────────────────────────────────
-- Real-time "git blame with intent." Every Edit/Write auto-records the
-- file path plus the worker's current task context (from digest or task
-- board). When another worker encounters the same file, they instantly
-- see who was here and what goal they were pursuing — context follows
-- the file, not the session.
CREATE TABLE IF NOT EXISTS file_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    session_name TEXT,
    task_summary TEXT,
    task_title TEXT,
    tool_name TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_file_activity_lookup
    ON file_activity(workspace_id, file_path, created_at);
CREATE INDEX IF NOT EXISTS idx_file_activity_session
    ON file_activity(session_id);

-- ─── W2W: Embeddings store ──────────────────────────────────────────
-- Generic embedding storage for cosine similarity search. Each entity
-- (task, digest, knowledge, session, guideline) gets a dense vector from fastembed.
-- Vectors are stored as JSON float arrays (simpler than BLOB for debug).
-- At our scale (hundreds to low thousands), linear scan with Python
-- cosine is fast enough. HNSW indexing can be added later if needed.
CREATE TABLE IF NOT EXISTS embeddings (
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    workspace_id TEXT,
    dense_text TEXT,
    vector TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_embeddings_type_ws
    ON embeddings(entity_type, workspace_id);

-- Session Advisor: per-message semantic pole scores (satisfaction, certainty, etc.)
CREATE TABLE IF NOT EXISTS message_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    message_hash TEXT NOT NULL,
    satisfaction REAL,
    certainty REAL,
    engagement REAL,
    correction REAL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_msg_scores_session
    ON message_scores(session_id);

-- Session Advisor: aggregated session quality from semantic pole scoring
CREATE TABLE IF NOT EXISTS session_quality (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    workspace_id TEXT,
    score REAL DEFAULT 0.5,
    satisfaction_avg REAL,
    certainty_avg REAL,
    engagement_avg REAL,
    correction_avg REAL,
    message_count INTEGER DEFAULT 0,
    guideline_ids TEXT DEFAULT '[]',
    analyzed_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sq_workspace
    ON session_quality(workspace_id);

-- Session Advisor: guideline effectiveness tracking per workspace
CREATE TABLE IF NOT EXISTS guideline_effectiveness (
    id TEXT PRIMARY KEY,
    guideline_id TEXT REFERENCES guidelines(id) ON DELETE CASCADE,
    workspace_id TEXT,
    session_count INTEGER DEFAULT 0,
    avg_quality REAL DEFAULT 0.5,
    quality_delta REAL DEFAULT 0.0,
    confidence REAL DEFAULT 0.0,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(guideline_id, workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_guideline_eff_workspace
    ON guideline_effectiveness(workspace_id);

-- Session Advisor: track which sessions each guideline was recommended to
-- Used to compute generality: guidelines recommended to many distinct sessions
-- are penalized (they match everything, so they're noise, not signal).
CREATE TABLE IF NOT EXISTS guideline_rec_history (
    guideline_id TEXT NOT NULL REFERENCES guidelines(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(guideline_id, session_id)
);

-- Safety Gate: configurable rules for tool call evaluation
CREATE TABLE IF NOT EXISTS safety_rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    category TEXT NOT NULL,
    severity TEXT NOT NULL,
    tool_match TEXT NOT NULL,
    pattern TEXT NOT NULL,
    pattern_field TEXT DEFAULT '',
    action TEXT NOT NULL DEFAULT 'deny',
    enabled INTEGER DEFAULT 1,
    is_builtin INTEGER DEFAULT 0,
    workspace_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_safety_rules_enabled
    ON safety_rules(enabled, workspace_id);

-- Safety Gate: decision audit log
CREATE TABLE IF NOT EXISTS safety_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_use_id TEXT,
    session_id TEXT,
    workspace_id TEXT,
    tool_name TEXT NOT NULL,
    tool_input_summary TEXT,
    matched_rule_id TEXT,
    decision TEXT NOT NULL,
    reason TEXT,
    user_response TEXT,
    latency_ms INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_safety_decisions_session
    ON safety_decisions(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_safety_decisions_tool_use
    ON safety_decisions(tool_use_id);
CREATE INDEX IF NOT EXISTS idx_safety_decisions_pattern
    ON safety_decisions(tool_name, decision);

-- Compliance: every external source accessed by agents
CREATE TABLE IF NOT EXISTS external_access_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    workspace_id TEXT,
    tool_name TEXT NOT NULL,
    url TEXT NOT NULL,
    domain TEXT,
    source_type TEXT DEFAULT 'unknown',
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_external_access_session
    ON external_access_log(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_external_access_domain
    ON external_access_log(domain, created_at);

-- Compliance: every command executed by agents
CREATE TABLE IF NOT EXISTS command_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    workspace_id TEXT,
    command TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_command_log_session
    ON command_log(session_id, created_at);

-- Compliance: package install scans with AVCP results
CREATE TABLE IF NOT EXISTS package_scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    workspace_id TEXT,
    package TEXT NOT NULL,
    ecosystem TEXT NOT NULL,
    version TEXT DEFAULT '',
    age_days INTEGER DEFAULT -1,
    status TEXT DEFAULT 'ok',
    vuln_count INTEGER DEFAULT 0,
    vuln_critical INTEGER DEFAULT 0,
    known_malware INTEGER DEFAULT 0,
    decision TEXT DEFAULT 'allow',
    reason TEXT DEFAULT '',
    advisories TEXT DEFAULT '[]',
    install_scripts TEXT DEFAULT '',
    llm_verdict TEXT DEFAULT '',
    fallback TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_package_scans_session
    ON package_scans(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_package_scans_package
    ON package_scans(package, ecosystem);

-- Compliance: install-script allowlist (packages approved to run install scripts)
CREATE TABLE IF NOT EXISTS install_script_allowlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    package TEXT NOT NULL,
    ecosystem TEXT NOT NULL,
    reason TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(package, ecosystem)
);

-- Pipeline Engine: configurable graph-based pipelines
CREATE TABLE IF NOT EXISTS pipeline_definitions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT 'Untitled Pipeline',
    description TEXT DEFAULT '',
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
    stages TEXT DEFAULT '[]',
    transitions TEXT DEFAULT '[]',
    triggers TEXT DEFAULT '[]',
    preset INTEGER DEFAULT 0,
    preset_key TEXT UNIQUE,
    status TEXT DEFAULT 'draft',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pipeline_definitions_workspace
    ON pipeline_definitions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_definitions_preset
    ON pipeline_definitions(preset_key);

CREATE TABLE IF NOT EXISTS pipeline_runs (
    id TEXT PRIMARY KEY,
    pipeline_id TEXT REFERENCES pipeline_definitions(id) ON DELETE CASCADE,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    status TEXT DEFAULT 'pending',
    current_stages TEXT DEFAULT '[]',
    iteration INTEGER DEFAULT 1,
    max_iterations INTEGER DEFAULT 20,
    variables TEXT DEFAULT '{}',
    stage_history TEXT DEFAULT '{}',
    trigger_type TEXT DEFAULT 'manual',
    error TEXT,
    started_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pipeline
    ON pipeline_runs(pipeline_id, status);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_workspace
    ON pipeline_runs(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_task
    ON pipeline_runs(task_id);

-- ─── Observatory: automated ecosystem scanner ───────────────────
CREATE TABLE IF NOT EXISTS observatory_findings (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,
    source TEXT NOT NULL,
    source_url TEXT,
    title TEXT NOT NULL,
    description TEXT,
    category TEXT DEFAULT 'integrate',
    relevance_score REAL DEFAULT 0,
    proposal TEXT,
    steal_targets TEXT DEFAULT '[]',
    tags TEXT DEFAULT '[]',
    notes TEXT,
    status TEXT DEFAULT 'new',
    promoted_task_id TEXT,
    metadata TEXT DEFAULT '{}',
    scan_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_observatory_findings_source
    ON observatory_findings(source, relevance_score DESC);
CREATE INDEX IF NOT EXISTS idx_observatory_findings_status
    ON observatory_findings(status);
CREATE INDEX IF NOT EXISTS idx_observatory_findings_workspace
    ON observatory_findings(workspace_id);

CREATE TABLE IF NOT EXISTS observatory_scans (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,
    source TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    findings_count INTEGER DEFAULT 0,
    error TEXT,
    started_at TEXT,
    completed_at TEXT
);

CREATE TABLE IF NOT EXISTS observatory_sources (
    workspace_id TEXT NOT NULL DEFAULT '__global__',
    source TEXT NOT NULL,
    enabled INTEGER DEFAULT 0,
    interval_hours INTEGER DEFAULT 24,
    mode TEXT DEFAULT 'both',
    keywords TEXT DEFAULT '[]',
    last_scan_at TEXT,
    PRIMARY KEY (workspace_id, source)
);

-- ─── Observatory: prose-based project profile (per workspace) ────────
-- The profile is a JSON dict of markdown strings. Nothing here is
-- keyword-matched — every downstream LLM call consumes the prose as
-- context. Sections cover identity, interests, current_stack,
-- competitors, audience, tone, dismissal_patterns.
CREATE TABLE IF NOT EXISTS observatory_profiles (
    workspace_id TEXT PRIMARY KEY,
    profile TEXT NOT NULL DEFAULT '{}',
    last_recalibration_notes TEXT DEFAULT '',
    inputs_hash TEXT,
    generated_at TEXT,
    user_edited_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- ─── Observatory: curated search-target list (LLM-aggregated) ────────
-- Sub-sources the LLM has decided are worth scanning: subreddits, GitHub
-- topics, Product Hunt categories, X hashtags, search-query strings.
-- Persists across scans; the planner reads the existing list, scores
-- yields, proposes additions, and retires low-signal targets.
CREATE TABLE IF NOT EXISTS observatory_search_targets (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,
    source TEXT NOT NULL,
    target_type TEXT NOT NULL,
    value TEXT NOT NULL,
    rationale TEXT,
    status TEXT DEFAULT 'active',
    added_by TEXT,
    hit_count INTEGER DEFAULT 0,
    yield_count INTEGER DEFAULT 0,
    signal_score REAL DEFAULT 0.5,
    last_scanned_at TEXT,
    last_yielded_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(workspace_id, source, target_type, value)
);

CREATE INDEX IF NOT EXISTS idx_observatory_targets_lookup
    ON observatory_search_targets(workspace_id, source, status);

-- ─── Observatory: aggregated insights memory ─────────────────────────
-- Distilled, deduped facts the LLM derives from findings over time:
-- competitors observed, recurring user pain points, feature gaps,
-- already-shipped integrations the scanner should stop re-flagging.
-- Each insight has a strength score and evidence pointing back to the
-- source findings.
CREATE TABLE IF NOT EXISTS observatory_insights (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,
    insight_type TEXT NOT NULL,        -- 'competitor' | 'pain_point' | 'feature_gap' | 'integration_done'
    name TEXT NOT NULL,                -- short canonical name (LLM dedupes against this)
    summary TEXT NOT NULL,             -- 1-2 sentence prose
    evidence TEXT DEFAULT '[]',        -- JSON array of finding_ids
    strength REAL DEFAULT 0.5,         -- 0..1, smoothed; grows with corroborating findings
    last_seen_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_observatory_insights_lookup
    ON observatory_insights(workspace_id, insight_type, strength DESC);

CREATE TABLE IF NOT EXISTS research_schedules (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,
    query TEXT NOT NULL,
    mode TEXT DEFAULT 'auto',
    mcp_server_ids TEXT DEFAULT '[]',
    plan TEXT DEFAULT '{}',
    interval_hours INTEGER DEFAULT 24,
    enabled INTEGER DEFAULT 1,
    last_run_at TEXT,
    next_run_at TEXT,
    last_job_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    encoded_speakable TEXT,
    encoded_compact TEXT,
    mode TEXT NOT NULL,
    brief_subscope TEXT,
    ttl_seconds INTEGER NOT NULL,
    label TEXT,
    redemption_attempts INTEGER NOT NULL DEFAULT 0,
    redeemed_at TEXT,
    redeemed_by_session_id TEXT,
    burned_at TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_invites_hash ON invites(token_hash);
CREATE INDEX IF NOT EXISTS idx_invites_active ON invites(redeemed_at, burned_at, expires_at);

-- ─── PR 2: per-row joiner sessions ─────────────────────────────────────
-- A row per active bearer/cookie. Owner-equivalent rows mint via the
-- legacy AUTH_TOKEN bootstrap or (future) Ed25519 device pairing; joiner
-- rows mint via invite redemption. Sliding TTL clamped by hard_cap_at.
CREATE TABLE IF NOT EXISTS joiner_sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,           -- SHA-256 of cookie value
    invite_id TEXT REFERENCES invites(id) ON DELETE SET NULL,
    label TEXT,
    mode TEXT NOT NULL,                        -- 'brief' | 'code' | 'full'
    brief_subscope TEXT,
    actor_kind TEXT NOT NULL,                  -- 'owner_legacy' | 'owner_device' | 'joiner_session'
    device_id TEXT,                            -- (PR2-future) FK to devices(id)
    created_at TEXT DEFAULT (datetime('now')),
    last_used_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,                  -- slides each request, capped at hard_cap_at
    hard_cap_at TEXT NOT NULL,                 -- created_at + 90d
    revoked_at TEXT,
    last_ip TEXT,
    last_user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_joiner_sessions_hash ON joiner_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_joiner_sessions_active
    ON joiner_sessions(revoked_at, expires_at);

-- ─── PR 2: Owner device pairing (Ed25519) ────────────────────────────
-- A device row represents a hardware-bound public key (browser/phone)
-- that the owner has authorized. Pair-init records the pubkey and
-- issues a challenge nonce; pair-complete verifies a signature over
-- the nonce and mints an `actor_kind='owner_device'` joiner_sessions
-- row tied to this device. Revoking a device cascades joiner_sessions
-- rows minted for it.
CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    public_key TEXT NOT NULL,                  -- Ed25519 pubkey, base64url (raw 32 bytes)
    fingerprint TEXT NOT NULL UNIQUE,          -- SHA-256(pubkey_bytes) hex
    user_agent TEXT,
    paired_at TEXT DEFAULT (datetime('now')),
    last_seen_at TEXT DEFAULT (datetime('now')),
    revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_devices_fingerprint ON devices(fingerprint);
CREATE INDEX IF NOT EXISTS idx_devices_active ON devices(revoked_at);

CREATE TABLE IF NOT EXISTS device_challenges (
    nonce TEXT PRIMARY KEY,                    -- 32 bytes base64url
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    issued_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,                  -- issued_at + 5 min
    consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_device_challenges_device
    ON device_challenges(device_id, consumed_at);

-- ─── PR 4: Web Push subscriptions ────────────────────────────────────
-- One row per (actor, browser endpoint). When the catchup digest
-- detects a >Nh absence (or owner taps "Send to phone"), we POST a
-- push to the endpoint with VAPID headers. No subscription = silent.
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY,
    actor_kind TEXT NOT NULL,                  -- 'owner_legacy' | 'owner_device' | 'joiner_session'
    actor_id TEXT,                             -- joiner_sessions.id, or NULL for owner_legacy
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    last_used_at TEXT,
    UNIQUE(actor_kind, actor_id, endpoint)
);
CREATE INDEX IF NOT EXISTS idx_push_subs_actor
    ON push_subscriptions(actor_kind, actor_id);

-- ─── Audit log: every authenticated mutation by joiners + owner ──────
-- Records who did what, when, from where. Owner-only readable via
-- GET /api/audit. The frontend Auth Sessions panel drills in by actor_id.
CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    actor_kind TEXT NOT NULL,                  -- 'owner_legacy' | 'owner_device' | 'joiner_session' | 'anon'
    actor_id TEXT,                             -- joiner_sessions.id for joiners; NULL for owner_legacy
    actor_label TEXT,                          -- joiner_sessions.label snapshot (denormalized — labels can change)
    mode TEXT,                                 -- 'brief' | 'code' | 'full' | NULL for owner_legacy
    method TEXT NOT NULL,                      -- HTTP method
    path TEXT NOT NULL,                        -- request path
    status INTEGER,                            -- response status
    ip TEXT,
    user_agent TEXT,
    summary TEXT,                              -- short JSON: target id, name, action verb
    ts TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_actor
    ON audit_log(actor_kind, actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_ts
    ON audit_log(ts);

-- ─── Performance indexes for high-frequency queries ──────────────────
CREATE INDEX IF NOT EXISTS idx_sessions_workspace
    ON sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status
    ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_messages_session
    ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_session_mcp_servers_session
    ON session_mcp_servers(session_id);
CREATE INDEX IF NOT EXISTS idx_session_guidelines_session
    ON session_guidelines(session_id);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace_status
    ON tasks(workspace_id, status);
"""


async def get_db() -> aiosqlite.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    db = await aiosqlite.connect(str(DB_PATH))
    db.row_factory = aiosqlite.Row
    await db.execute("PRAGMA journal_mode=WAL")
    await db.execute("PRAGMA foreign_keys=ON")
    return db


SEED_QUICKACTION_PROMPTS = [
    {"id": "qa-review",   "name": "Review",   "content": "Review the recent code changes for issues and improvements", "icon": "file-code",  "color": "text-blue-400",   "order": 0},
    {"id": "qa-commit",   "name": "Commit",   "content": "Create a git commit for the current changes with a good message", "icon": "git-branch", "color": "text-green-400",  "order": 1},
    {"id": "qa-security", "name": "Security", "content": "Do a security review of the recent changes", "icon": "shield",     "color": "text-red-400",    "order": 2},
    {"id": "qa-test",     "name": "Test",     "content": "Run the tests and fix any failures", "icon": "test-tube",  "color": "text-yellow-400", "order": 3},
    {"id": "qa-fix",      "name": "Fix",      "content": "Look at the recent changes and fix any bugs or issues", "icon": "bug",        "color": "text-orange-400", "order": 4},
    {"id": "qa-explain",  "name": "Explain",  "content": "Explain the code in this project", "icon": "book-open",  "color": "text-cyan-400",   "order": 5},
    {"id": "qa-suggest",  "name": "Suggest",  "content": "Suggest improvements to the recent changes", "icon": "lightbulb",  "color": "text-amber-400",  "order": 6},
]

SEED_MCP_SERVERS = [
    {
        "id": "builtin-commander",
        "name": "Commander",
        "server_name": "commander",
        "description": "IVE orchestration — manage worker sessions, tasks, research",
        "server_type": "stdio",
        "command": "python3",
        "args": [str(MCP_SERVER_PATH)],
        "env": {
            "COMMANDER_API_URL": "http://{host}:{port}",
            "COMMANDER_WORKSPACE_ID": "{workspace_id}",
        },
        "auto_approve": 1,
        "default_enabled": 1,
        "is_builtin": 1,
    },
    {
        "id": "builtin-worker-board",
        "name": "Worker Board",
        "server_name": "worker-board",
        "description": "Lets workers see and update their assigned tasks on the feature board",
        "server_type": "stdio",
        "command": "python3",
        "args": [str(WORKER_MCP_SERVER_PATH)],
        "env": {
            "COMMANDER_API_URL": "http://{host}:{port}",
            "WORKER_SESSION_ID": "{session_id}",
            "WORKER_WORKSPACE_ID": "{workspace_id}",
            "WORKER_SESSION_TYPE": "{session_type}",
            # W2W flags plumbed at PTY spawn so the worker MCP doesn't have
            # to API-call the commander server at startup. Removes the
            # silent-fail mode where a startup race left zero W2W tools
            # registered but the prompt still referenced them.
            "WORKER_W2W_COMMS": "{w2w_comms}",
            "WORKER_W2W_CONTEXT": "{w2w_context}",
            "WORKER_W2W_COORDINATION": "{w2w_coordination}",
        },
        "auto_approve": 1,
        "default_enabled": 0,
        "is_builtin": 1,
    },
    {
        "id": "builtin-deep-research",
        "name": "Deep Research",
        "server_name": "deep-research",
        "description": "Multi-engine search, extract, and gather tools for deep research — searches Brave, DuckDuckGo, arXiv, Semantic Scholar, GitHub, SearXNG",
        "server_type": "stdio",
        "command": "python3",
        "args": [str(DEEP_RESEARCH_MCP_PATH)],
        "env": {
            "COMMANDER_API_URL": "http://{host}:{port}",
            "COMMANDER_WORKSPACE_ID": "{workspace_id}",
        },
        "auto_approve": 1,
        "default_enabled": 0,
        "is_builtin": 1,
    },
    {
        "id": "builtin-playwright",
        "name": "Playwright",
        "server_name": "playwright",
        "description": "Browser automation — navigate, click, fill forms, screenshot, and scrape web pages",
        "server_type": "stdio",
        "command": "npx",
        # Default to --headless so the Tester doesn't pop a browser window and
        # steal focus on every run. Sessions can opt into a visible browser via
        # the "Show browser" checkbox in the Tester picker (tag: tester_headed),
        # which strips --headless at PTY start.
        "args": ["-y", "@playwright/mcp@latest", "--headless"],
        "env": {},
        "auto_approve": 0,
        "is_builtin": 0,
    },
    {
        "id": "builtin-documentor",
        "name": "Documentor",
        "server_name": "documentor",
        "description": "Documentation generation — screenshot features, record GIF workflows, scaffold and build a VitePress docs site",
        "server_type": "stdio",
        "command": "python3",
        "args": [str(DOCUMENTOR_MCP_SERVER_PATH)],
        "env": {
            "COMMANDER_API_URL": "http://{host}:{port}",
            "COMMANDER_WORKSPACE_ID": "{workspace_id}",
            "COMMANDER_WORKSPACE_PATH": "{workspace_path}",
            "WORKER_SESSION_ID": "{session_id}",
        },
        "auto_approve": 1,
        "default_enabled": 0,
        "is_builtin": 1,
    },
]

def _load_deep_research_guideline() -> str:
    """Load the deep research methodology guideline from the plugin SKILL.md."""
    try:
        content = DEEP_RESEARCH_SKILL_PATH.read_text(encoding="utf-8")
        # Strip YAML frontmatter
        if content.startswith("---"):
            parts = content.split("---", 2)
            if len(parts) >= 3:
                content = parts[2].strip()
        return content
    except FileNotFoundError:
        return "Deep Research Methodology guideline not found. Install the deep-research plugin."


SEED_GUIDELINES = [
    {
        "id": "builtin-deep-research",
        "name": "Deep Research Methodology",
        "content": _load_deep_research_guideline(),
        "is_default": 0,
    },
    {
        "id": "builtin-thorough-verification",
        "name": "Thorough Verification",
        "content": """## Thorough Verification Protocol

After completing any code changes, you MUST perform tiered verification based on change size:

### Small changes (1-3 files, <50 lines)
- Run relevant tests for the changed code
- Verify the build still passes

### Medium changes (4-10 files, 50-200 lines)
- Run the full test suite — show complete output
- Run the build — show output
- Run the linter — show output
- Manually verify the feature works as intended (describe what you checked)

### Large changes (>10 files or >200 lines, security-related, or API changes)
- All of the above, plus:
- Check for regressions in related functionality
- Verify edge cases explicitly
- Review your own diff for accidental changes, debug leftovers, or TODO comments
- If security-related: check for injection, auth bypass, data exposure

### Rules
- NEVER claim something "should work" — run it and show actual output
- If a test fails, fix it and re-run ALL tests (not just the failing one)
- Show evidence: paste test output, build output, or terminal output as proof""",
    },
    {
        "id": "builtin-ralph-loop",
        "name": "Ralph Loop",
        "content": """## Ralph Mode — Persistent Execution Loop

You MUST keep working until the task is genuinely complete. Follow this loop:

1. EXECUTE: Implement the requested changes.
2. VERIFY: Run tests, build, lint — show ACTUAL output. Never say "should work".
3. FIX: If anything fails, fix the root cause and go back to step 2.
4. COMPLETE: Only when ALL checks pass with fresh evidence.

Max 20 iterations. State your phase each time (e.g., "Ralph iteration 3 — Verify").
If the same fix fails 3 times, try a fundamentally different approach.
When genuinely complete, say: "Ralph complete — all checks pass" with evidence.""",
    },
    {
        "id": "builtin-testing-agent",
        "name": "Testing Agent",
        "content": """## Testing Agent — Read-Only Verification Mode

You are a **testing agent**. Your sole purpose is to verify that features work correctly. You have access to browser automation via Playwright MCP.

### Rules
1. **NEVER modify source code files** (.js, .jsx, .ts, .tsx, .py, .go, .rs, .java, .c, .cpp, .rb, .php, .swift, .kt, .cs, etc.)
2. **NEVER modify config files** that affect application behavior (package.json scripts, webpack config, vite config, etc.)
3. You MAY create or edit:
   - Test result reports (markdown, txt)
   - Screenshots and visual evidence
   - Documentation about bugs found
   - Test plan documents
4. **Test systematically**: navigate the app, interact with UI elements, verify expected behavior, capture evidence
5. **Report clearly**: for each test, state what was tested, expected result, actual result, and pass/fail
6. If you find a bug, describe it precisely with reproduction steps — do NOT attempt to fix it

### Workflow
1. Read the task description and acceptance criteria
2. Create a test plan
3. Execute each test using Playwright (navigate, click, fill, screenshot)
4. Report results with evidence (screenshots, console output)
5. Summarize: total tests, passed, failed, with details on failures""",
    },
    {
        "id": "builtin-root-cause-first",
        "name": "Root Cause First",
        "content": """## Root Cause First — No Test Fixes, No Workarounds

When something fails (test, build, feature, behavior), your FIRST action must be tracing the actual data/control flow. Never adjust tests, add sleeps, loosen assertions, or work around the symptom.

### The Protocol

1. **TRACE, don't guess.** Read the code path that failed. Follow the data from input to output. Print intermediate values if needed. The bug is in the code, not the test.

2. **Never adjust a failing test** unless the test's expectation is provably wrong. If a test checks `X == Y` and gets `X == Z`, the question is "why does the code produce Z?" not "should the test accept Z?"

3. **Never add sleeps or retries** to make flaky behavior pass. Flakiness means a race condition or missing await — find it.

4. **Never loosen an assertion** ("check ANY message" instead of "check THE message"). The original assertion was specific for a reason. If it fails, the code is wrong.

5. **Check, don't speculate.** When you have multiple hypotheses, don't reason about which one is "most likely" — just verify them. Read the function, print the value, check the DB. Checking takes 10 seconds, speculating wastes minutes and is often wrong.

6. **Data flow over guesswork.** When confused about what a function returns, READ the function. Don't guess based on what you think it should return.

### Anti-Patterns to Avoid

- "Let me increase the timeout" → find the race condition
- "Let me make the test more resilient" → fix the code
- "Maybe there's stale data" → verify by checking, don't assume
- "Let me try a different approach" → understand why THIS approach failed first
- "It works in my head so the test must be wrong" → run it and read the output

### When the Test IS Wrong

Sometimes tests do have bugs. But prove it:
- Show that the code produces the correct output
- Show that the test's expected value is incorrect
- Fix the test AND explain why the original expectation was wrong""",
    },
    {
        "id": "builtin-documentation-agent",
        "name": "Documentation Agent",
        "content": """## Documentation Agent — Read-Only Documentation Mode

You are a **documentation agent**. Your purpose is to create comprehensive external-facing documentation for this project. You have access to browser automation (Playwright) for screenshots and GIF recording, and documentation tools for building a VitePress site.

### Rules
1. **NEVER modify source code files** — you are a documentation agent only
2. **NEVER fabricate features** — only document what you can verify exists in the codebase or UI
3. You MAY create or edit:
   - Documentation pages (markdown in docs/)
   - Screenshots and GIFs as visual evidence
   - VitePress config and theme files
   - The docs manifest for tracking coverage
4. **Explore systematically**: use get_knowledge_base() first, then screenshot features, then write docs
5. **Be thorough**: every major feature, every keyboard shortcut, every panel should be documented
6. If a feature requires specific state to screenshot (e.g., active sessions), describe it textually

### Documentation Page Template
For each feature page, follow this structure:
1. Overview — what it does (1-2 sentences)
2. Screenshot — the feature in its default and active states
3. Usage — step-by-step instructions
4. Keyboard Shortcuts — if applicable
5. GIF Demo — for multi-step workflows
6. Related Features — cross-links

### Incremental Updates
When updating existing docs, always check get_docs_manifest() first to see what's already documented.
Only update pages affected by recent changes. Don't re-screenshot unchanged UI.""",
    },
]


async def init_db():
    db = await get_db()
    try:
        await db.executescript(SCHEMA)

        # Lightweight column migrations for existing DBs (CREATE TABLE IF NOT
        # EXISTS won't add columns to a table that already exists). Each ALTER
        # is wrapped in try/except so re-running on a fresh DB is a no-op.
        for ddl in (
            "ALTER TABLE workspaces ADD COLUMN preview_url TEXT",
            # Stores the JSON array of guideline IDs that were ACTUALLY loaded
            # into --append-system-prompt at PTY start. Used by the GuidelinePanel
            # to distinguish "active in system prompt" from "toggled in DB but
            # not yet applied." Null = PTY hasn't started yet / never started.
            "ALTER TABLE sessions ADD COLUMN active_guideline_ids TEXT",
            "ALTER TABLE prompts ADD COLUMN is_quickaction INTEGER DEFAULT 0",
            "ALTER TABLE prompts ADD COLUMN quickaction_order INTEGER DEFAULT 0",
            "ALTER TABLE prompts ADD COLUMN icon TEXT",
            "ALTER TABLE prompts ADD COLUMN color TEXT",
            "ALTER TABLE prompts ADD COLUMN source_type TEXT",
            "ALTER TABLE prompts ADD COLUMN source_url TEXT",
            "ALTER TABLE plugin_components ADD COLUMN activation TEXT DEFAULT 'always'",
            "ALTER TABLE cascades ADD COLUMN auto_approve INTEGER DEFAULT 0",
            "ALTER TABLE cascades ADD COLUMN bypass_permissions INTEGER DEFAULT 0",
            "ALTER TABLE accounts ADD COLUMN browser_path TEXT",
            "ALTER TABLE accounts ADD COLUMN chrome_profile TEXT",
            "ALTER TABLE workspaces ADD COLUMN coordination_namespace TEXT",
            "ALTER TABLE sessions ADD COLUMN active_mcp_server_ids TEXT",
            "ALTER TABLE templates ADD COLUMN mcp_server_ids TEXT",
            "ALTER TABLE prompts ADD COLUMN mcp_server_ids TEXT",
            "ALTER TABLE sessions ADD COLUMN plan_model TEXT",
            "ALTER TABLE sessions ADD COLUMN execute_model TEXT",
            "ALTER TABLE templates ADD COLUMN plan_model TEXT",
            "ALTER TABLE templates ADD COLUMN execute_model TEXT",
            "ALTER TABLE tasks ADD COLUMN test_with_agent INTEGER DEFAULT 0",
            "ALTER TABLE workspaces ADD COLUMN tester_mode TEXT DEFAULT 'direct'",
            "ALTER TABLE sessions ADD COLUMN auto_approve_plan INTEGER DEFAULT 0",
            "ALTER TABLE templates ADD COLUMN auto_approve_plan INTEGER DEFAULT 0",
            "ALTER TABLE cascades ADD COLUMN auto_approve_plan INTEGER DEFAULT 0",
            "ALTER TABLE cascades ADD COLUMN variables TEXT DEFAULT '[]'",
            "ALTER TABLE cascades ADD COLUMN loop_reprompt INTEGER DEFAULT 0",
            "ALTER TABLE workspaces ADD COLUMN default_worktree INTEGER DEFAULT 0",
            # W2W: Three independently toggleable features per workspace
            "ALTER TABLE workspaces ADD COLUMN comms_enabled INTEGER DEFAULT 0",
            "ALTER TABLE workspaces ADD COLUMN coordination_enabled INTEGER DEFAULT 0",
            "ALTER TABLE workspaces ADD COLUMN context_sharing_enabled INTEGER DEFAULT 0",
            # W2W: Task lessons — carry knowledge from completed tasks to future similar work
            "ALTER TABLE tasks ADD COLUMN lessons_learned TEXT",
            "ALTER TABLE tasks ADD COLUMN important_notes TEXT",
            "ALTER TABLE sessions RENAME COLUMN claude_session_id TO native_session_id",
            "ALTER TABLE sessions RENAME COLUMN claude_slug TO native_slug",
            "ALTER TABLE workspaces ADD COLUMN output_style TEXT",
            "ALTER TABLE workspaces ADD COLUMN knowledge_context_limit INTEGER DEFAULT 3000",
            "ALTER TABLE sessions ADD COLUMN output_style TEXT",
            # Native terminals: pop-out sessions to OS terminal, auto-register external CLIs
            "ALTER TABLE workspaces ADD COLUMN native_terminals_enabled INTEGER DEFAULT 0",
            "ALTER TABLE workspaces ADD COLUMN auto_register_terminals INTEGER DEFAULT 0",
            # Track which sessions are external (running in a native terminal, not PTY)
            "ALTER TABLE sessions ADD COLUMN is_external INTEGER DEFAULT 0",
            "ALTER TABLE sessions ADD COLUMN external_pid TEXT",
            # Auto-exec: automatic task dispatch to Commander
            "ALTER TABLE workspaces ADD COLUMN auto_exec_enabled INTEGER DEFAULT 0",
            "ALTER TABLE workspaces ADD COLUMN commander_max_workers INTEGER DEFAULT 3",
            "ALTER TABLE workspaces ADD COLUMN tester_max_workers INTEGER DEFAULT 2",
            # Ticket iteration: v2/v3 revision system
            "ALTER TABLE tasks ADD COLUMN iteration INTEGER DEFAULT 1",
            "ALTER TABLE tasks ADD COLUMN last_agent_session_id TEXT",
            "ALTER TABLE tasks ADD COLUMN iteration_history TEXT",
            # Session Advisor: workspace opt-in for auto-attaching recommended guidelines
            "ALTER TABLE workspaces ADD COLUMN advisor_auto_attach INTEGER DEFAULT 0",
            # Session Advisor: optional session purpose for intent seeding
            "ALTER TABLE sessions ADD COLUMN purpose TEXT",
            # Session Advisor: when_to_use metadata for smarter guideline matching
            "ALTER TABLE guidelines ADD COLUMN when_to_use TEXT",
            # Plugin protection: builtin guidelines can be edited but not deleted
            "ALTER TABLE guidelines ADD COLUMN is_builtin INTEGER DEFAULT 0",
            # Per-workspace research depth: max iterations for deep research loop
            "ALTER TABLE workspaces ADD COLUMN research_max_iterations INTEGER",
            # Worker queue: session domain tags + per-worker task queuing
            "ALTER TABLE sessions ADD COLUMN tags TEXT DEFAULT '[]'",
            "ALTER TABLE tasks ADD COLUMN queued_for_session_id TEXT",
            "ALTER TABLE tasks ADD COLUMN queue_order INTEGER DEFAULT 0",
            # Index for fast queue lookups (must come after ALTER TABLEs)
            "CREATE INDEX IF NOT EXISTS idx_tasks_queued_for ON tasks(queued_for_session_id, queue_order)",
            # Worktree path for branch sessions created via /branch
            "ALTER TABLE sessions ADD COLUMN worktree_path TEXT",
            # Branch group labels: linked peer sessions from /branch
            "ALTER TABLE sessions ADD COLUMN branch_group TEXT",
            "ALTER TABLE sessions ADD COLUMN branch_label TEXT",
            # Task Pipeline: automated implement → test → document loop
            "ALTER TABLE tasks ADD COLUMN pipeline INTEGER DEFAULT 0",
            "ALTER TABLE tasks ADD COLUMN pipeline_max_iterations INTEGER DEFAULT 5",
            "ALTER TABLE tasks ADD COLUMN pipeline_stage TEXT",
            "ALTER TABLE workspaces ADD COLUMN pipeline_enabled INTEGER DEFAULT 0",
            # Task dependencies: opt-in per workspace
            "ALTER TABLE tasks ADD COLUMN depends_on TEXT DEFAULT '[]'",
            "ALTER TABLE workspaces ADD COLUMN task_dependencies_enabled INTEGER DEFAULT 0",
            # Grid templates: scope to workspace
            "ALTER TABLE grid_templates ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE",
            # Session archive & post-hoc summary
            "ALTER TABLE sessions ADD COLUMN archived INTEGER DEFAULT 0",
            "ALTER TABLE sessions ADD COLUMN summary TEXT",
            # Package scans: LLM verdict for install script analysis
            "ALTER TABLE package_scans ADD COLUMN llm_verdict TEXT DEFAULT ''",
            # Memory injection tracking: JSON with count + chars injected at PTY start
            "ALTER TABLE sessions ADD COLUMN memory_injected_info TEXT",
            # Autolearn: rows authored by the auto_learn module are flagged auto=1
            # so the UI can route them to a review queue instead of mixing them
            # with manually curated memory. confidence is the LLM's self-rated
            # 0..1 score for how durable/non-obvious the insight is.
            "ALTER TABLE memory_entries ADD COLUMN auto INTEGER DEFAULT 0",
            "ALTER TABLE memory_entries ADD COLUMN confidence REAL DEFAULT 1.0",
            # Observatory smart pipeline: per-finding triage verdict + reasoning,
            # voice-of-customer extraction blob, page extraction provenance.
            "ALTER TABLE observatory_findings ADD COLUMN verdict TEXT",
            "ALTER TABLE observatory_findings ADD COLUMN triage_reason TEXT",
            "ALTER TABLE observatory_findings ADD COLUMN voice TEXT DEFAULT '{}'",
            "ALTER TABLE observatory_findings ADD COLUMN extracted_url TEXT",
            "ALTER TABLE observatory_findings ADD COLUMN extracted_chars INTEGER DEFAULT 0",
            "ALTER TABLE observatory_findings ADD COLUMN target_id TEXT",
            # W2W: Blocking bulletins — peer messages that pause the sender
            # until a reply arrives (used by `blocking_bulletin` MCP tool).
            # `blocking=1` means the sender is awaiting a reply; a peer
            # response with `in_reply_to=<bulletin_id>` releases the wait.
            "ALTER TABLE peer_messages ADD COLUMN blocking INTEGER DEFAULT 0",
            "ALTER TABLE peer_messages ADD COLUMN in_reply_to TEXT",
            "ALTER TABLE peer_messages ADD COLUMN reply_received INTEGER DEFAULT 0",
            "CREATE INDEX IF NOT EXISTS idx_peer_messages_in_reply_to ON peer_messages(in_reply_to)",
            # Demo runner: per-workspace stable preview build (see backend/demo_runner.py)
            "ALTER TABLE workspaces ADD COLUMN demo_command TEXT DEFAULT 'npm run dev'",
            "ALTER TABLE workspaces ADD COLUMN demo_branch TEXT DEFAULT 'main'",
            "ALTER TABLE workspaces ADD COLUMN demo_port INTEGER DEFAULT 0",
            # Auto-extract workspace knowledge from completed sessions on clean exit
            "ALTER TABLE workspaces ADD COLUMN auto_knowledge_enabled INTEGER DEFAULT 0",
            # PR 2: per-row identity on each session (who started it / what mode)
            "ALTER TABLE sessions ADD COLUMN owner_actor_kind TEXT",
            "ALTER TABLE sessions ADD COLUMN owner_actor_id TEXT",
            "ALTER TABLE sessions ADD COLUMN owner_mode TEXT",
            # Active ticket binding: the session's currently-bound ticket,
            # injected per-turn into the system prompt as ambient context.
            # Distinct from task_id (commander-assigned, immutable for audit).
            # Worker switches via switch_active_ticket; document_to_board
            # uses this at completion.
            "ALTER TABLE sessions ADD COLUMN active_ticket_id TEXT",
            "ALTER TABLE sessions ADD COLUMN board_action TEXT",
            "ALTER TABLE sessions ADD COLUMN board_action_at TEXT",
            "ALTER TABLE sessions ADD COLUMN board_action_note TEXT",
            # Per-workspace feature-board documentation policy.
            "ALTER TABLE workspaces ADD COLUMN board_doc_mode TEXT DEFAULT 'agent_with_backstop'",
            "ALTER TABLE workspaces ADD COLUMN board_doc_new_column TEXT DEFAULT 'review'",
            "ALTER TABLE workspaces ADD COLUMN board_doc_existing_column TEXT DEFAULT 'review'",
            # Code catalog: structural function-level memory layered on
            # workspace_knowledge. category='code_catalog' rows carry these
            # extra columns; all other categories leave them NULL.
            "ALTER TABLE workspace_knowledge ADD COLUMN symbol_name TEXT",
            "ALTER TABLE workspace_knowledge ADD COLUMN symbol_file TEXT",
            "ALTER TABLE workspace_knowledge ADD COLUMN symbol_kind TEXT",
            "ALTER TABLE workspace_knowledge ADD COLUMN stale_since TEXT",
            "CREATE INDEX IF NOT EXISTS idx_wk_symbol_lookup ON workspace_knowledge(workspace_id, symbol_file, symbol_name)",
            "CREATE INDEX IF NOT EXISTS idx_wk_catalog_stale ON workspace_knowledge(workspace_id, stale_since)",
            # Per-workspace toggles for code-catalog auto-extract on session end
            # and the optional verify pass (default OFF for cost reasons).
            "ALTER TABLE workspaces ADD COLUMN code_catalog_auto_extract INTEGER DEFAULT 1",
            "ALTER TABLE workspaces ADD COLUMN code_catalog_verify_session_end INTEGER DEFAULT 0",
            "ALTER TABLE workspaces ADD COLUMN code_catalog_model TEXT",
        ):
            try:
                await db.execute(ddl)
            except Exception:
                pass  # column already exists

        # Seed built-in guidelines (INSERT OR IGNORE = only on first run)
        for g in SEED_GUIDELINES:
            await db.execute(
                "INSERT OR IGNORE INTO guidelines (id, name, content, is_default, is_builtin) VALUES (?, ?, ?, 0, ?)",
                (g["id"], g["name"], g["content"], 1 if g["id"].startswith("builtin-") else 0),
            )
        # Backfill is_builtin for existing builtin guidelines
        await db.execute(
            "UPDATE guidelines SET is_builtin = 1 WHERE id LIKE 'builtin-%'"
        )

        # Seed built-in MCP servers
        for ms in SEED_MCP_SERVERS:
            await db.execute(
                """INSERT OR IGNORE INTO mcp_servers
                   (id, name, server_name, description, server_type, command, args, env,
                    auto_approve, default_enabled, is_builtin)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (ms["id"], ms["name"], ms["server_name"], ms["description"],
                 ms["server_type"], ms["command"],
                 json.dumps(ms["args"]),
                 json.dumps(ms["env"]),
                 ms.get("auto_approve", 0), ms.get("default_enabled", 0), ms.get("is_builtin", 0)),
            )

        # Ensure builtin-commander has default_enabled=1 (backfill for existing DBs)
        await db.execute(
            "UPDATE mcp_servers SET default_enabled = 1 WHERE id = 'builtin-commander'"
        )

        # Backfill worker-board env (existing DBs won't pick up SEED_MCP_SERVERS
        # changes since INSERT OR IGNORE skips existing rows). Add any missing
        # keys without disturbing user customizations.
        try:
            cur = await db.execute(
                "SELECT env FROM mcp_servers WHERE id = 'builtin-worker-board'"
            )
            row = await cur.fetchone()
            if row:
                env = json.loads(row["env"] or "{}")
                changed = False
                for key, default in (
                    ("WORKER_WORKSPACE_ID", "{workspace_id}"),
                    ("WORKER_SESSION_TYPE", "{session_type}"),
                    ("WORKER_W2W_COMMS", "{w2w_comms}"),
                    ("WORKER_W2W_CONTEXT", "{w2w_context}"),
                    ("WORKER_W2W_COORDINATION", "{w2w_coordination}"),
                ):
                    if key not in env:
                        env[key] = default
                        changed = True
                if changed:
                    await db.execute(
                        "UPDATE mcp_servers SET env = ? WHERE id = 'builtin-worker-board'",
                        (json.dumps(env),),
                    )
        except Exception:
            pass

        # Backfill --headless on the Playwright MCP for existing DBs. Only
        # rewrite if the row still has the old default args; respect any user
        # customization.
        try:
            cur = await db.execute(
                "SELECT args FROM mcp_servers WHERE id = 'builtin-playwright'"
            )
            row = await cur.fetchone()
            if row:
                args = json.loads(row["args"] or "[]")
                if args == ["-y", "@playwright/mcp@latest"]:
                    await db.execute(
                        "UPDATE mcp_servers SET args = ? WHERE id = 'builtin-playwright'",
                        (json.dumps(["-y", "@playwright/mcp@latest", "--headless"]),),
                    )
        except Exception:
            pass

        # Seed the deep-research plugin entry so it shows in the marketplace
        await db.execute(
            """INSERT OR IGNORE INTO plugins
               (id, name, version, description, author, source_format,
                categories, tags, security_tier, installed, installed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))""",
            ("builtin-deep-research", "Deep Research", "1.0.0",
             "CLI-native deep research — multi-engine search, extraction, and Research DB integration. "
             "Turns any CLI session into a deep researcher with iterative multi-angle methodology.",
             "IVE", "ive",
             json.dumps(["research", "search", "knowledge"]),
             json.dumps(["deep-research", "web-search", "multi-engine", "iterative", "cross-domain"]),
             1),
        )
        # Seed the plugin's guideline component
        await db.execute(
            """INSERT OR IGNORE INTO plugin_components
               (id, plugin_id, type, name, description, content, activation)
               VALUES (?, ?, 'guideline', ?, ?, ?, 'always')""",
            ("builtin-dr-methodology", "builtin-deep-research",
             "Deep Research Methodology",
             "Multi-angle iterative research with cross-domain exploration and claim verification",
             _load_deep_research_guideline()),
        )

        # Seed built-in quick action prompts
        for qa in SEED_QUICKACTION_PROMPTS:
            await db.execute(
                """INSERT OR IGNORE INTO prompts
                   (id, name, category, content, is_quickaction, quickaction_order, icon, color, source_type)
                   VALUES (?, ?, 'Quick Action', ?, 1, ?, ?, ?, 'seed')""",
                (qa["id"], qa["name"], qa["content"], qa["order"], qa["icon"], qa["color"]),
            )

        # Seed built-in plugin registries. INSERT OR IGNORE on the unique URL
        # so re-running on an existing DB is a no-op even if the user has
        # added their own registries alongside.
        for idx, reg in enumerate(DEFAULT_REGISTRIES):
            await db.execute(
                """INSERT OR IGNORE INTO plugin_registries
                   (id, name, url, enabled, is_builtin, last_sync_status, order_index)
                   VALUES (?, ?, ?, 1, 1, 'never', ?)""",
                (reg.get("id") or str(uuid.uuid4()), reg["name"], reg["url"], idx),
            )

        # One-shot backfill: flip workspaces.auto_knowledge_enabled from 0→1.
        # The column was added with DEFAULT 0; the runtime default is now 1.
        # Stamp-gated so users who explicitly turned it off after this runs
        # don't get re-flipped.
        try:
            cur = await db.execute(
                "SELECT value FROM app_settings WHERE key = '_migr_auto_knowledge_default_on'"
            )
            row = await cur.fetchone()
            if not row:
                await db.execute(
                    "UPDATE workspaces SET auto_knowledge_enabled = 1 "
                    "WHERE auto_knowledge_enabled = 0 OR auto_knowledge_enabled IS NULL"
                )
                await db.execute(
                    "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)",
                    ("_migr_auto_knowledge_default_on", "done"),
                )
        except Exception as exc:
            import logging
            logging.getLogger(__name__).warning(
                "auto_knowledge_enabled backfill skipped: %s", exc
            )

        # Seed experimental feature flags from the registry. INSERT OR IGNORE
        # preserves any flag the user has explicitly toggled (row already
        # present with "on" or "off"); only flags that have never been touched
        # get the registry's default_enabled value written.
        try:
            from experimental import EXPERIMENTAL_FEATURES
            for feat in EXPERIMENTAL_FEATURES.values():
                await db.execute(
                    "INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)",
                    (feat.key, "on" if feat.default_enabled else "off"),
                )
        except Exception as exc:
            # Don't let a registry import error block server startup.
            import logging
            logging.getLogger(__name__).warning(
                "Failed to seed experimental flags: %s", exc
            )

        await db.commit()
    finally:
        await db.close()
