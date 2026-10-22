"""Final-state IVE core schema for the fresh-install-only internal package.

Generated from an empty, I/O-guarded temporary database with no other products
selected. Contains declarations only: no application data or legacy migrations.
The development database initializer is deliberately not imported.
"""

SCHEMA_STATEMENTS = (
    # table: accounts
    "CREATE TABLE accounts (\n    id TEXT PRIMARY KEY,\n    name TEXT NOT NULL,\n    type TEXT NOT NULL DEFAULT 'api_key',\n    cli_type TEXT,\n    verified_subject TEXT,\n    credentials_verified_at TEXT,\n    api_key TEXT,\n    api_key_provider TEXT DEFAULT 'anthropic',\n    base_url TEXT,\n    model_aliases TEXT,\n    is_default INTEGER DEFAULT 0,\n    status TEXT DEFAULT 'active',\n    last_used_at TEXT,\n    quota_reset_at TEXT,\n    browser_path TEXT,\n    created_at TEXT DEFAULT (datetime('now'))\n)",
    # table: alloy_runs
    "CREATE TABLE alloy_runs (\n    id TEXT PRIMARY KEY,\n    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,\n    server_id TEXT REFERENCES alloy_servers(id) ON DELETE SET NULL,\n    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,\n    engine TEXT,\n    language TEXT,\n    raw_spec_path TEXT,\n    normalized_spec_path TEXT,\n    output_path TEXT,\n    manifest_path TEXT,\n    status TEXT DEFAULT 'recorded',\n    logs TEXT,\n    created_by_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,\n    created_at TEXT DEFAULT (datetime('now')),\n    updated_at TEXT DEFAULT (datetime('now'))\n)",
    # table: alloy_servers
    "CREATE TABLE alloy_servers (\n    id TEXT PRIMARY KEY,\n    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,\n    slug TEXT NOT NULL,\n    name TEXT NOT NULL,\n    description TEXT,\n    command TEXT NOT NULL,\n    args TEXT DEFAULT '[]',\n    cwd TEXT,\n    env TEXT DEFAULT '{}',\n    manifest_path TEXT,\n    raw_spec_path TEXT,\n    normalized_spec_path TEXT,\n    sdk_path TEXT,\n    mcp_path TEXT,\n    status TEXT DEFAULT 'registered',\n    last_error TEXT,\n    tool_cache TEXT,\n    created_by_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,\n    created_at TEXT DEFAULT (datetime('now')),\n    updated_at TEXT DEFAULT (datetime('now')),\n    last_healthcheck_at TEXT,\n    UNIQUE(workspace_id, slug)\n)",
    # table: app_settings
    "CREATE TABLE app_settings (\n    key TEXT PRIMARY KEY,\n    value TEXT,\n    updated_at TEXT DEFAULT (datetime('now'))\n)",
    # table: app_settings_ownership
    "CREATE TABLE app_settings_ownership (\n    key TEXT PRIMARY KEY,\n    extension_id TEXT NOT NULL\n)",
    # table: audit_log
    "CREATE TABLE audit_log (\n    id TEXT PRIMARY KEY,\n    actor_kind TEXT NOT NULL,                  -- 'owner_legacy' | 'owner_device' | 'joiner_session' | 'anon'\n    actor_id TEXT,                             -- joiner_sessions.id for joiners; NULL for owner_legacy\n    actor_label TEXT,                          -- joiner_sessions.label snapshot (denormalized — labels can change)\n    mode TEXT,                                 -- 'brief' | 'code' | 'full' | NULL for owner_legacy\n    method TEXT NOT NULL,                      -- HTTP method\n    path TEXT NOT NULL,                        -- request path\n    status INTEGER,                            -- response status\n    ip TEXT,\n    user_agent TEXT,\n    summary TEXT,                              -- short JSON: target id, name, action verb\n    ts TEXT DEFAULT (datetime('now'))\n)",
    # table: broadcast_groups
    "CREATE TABLE broadcast_groups (\n    id TEXT PRIMARY KEY,\n    name TEXT NOT NULL,\n    session_ids TEXT NOT NULL DEFAULT '[]',   -- JSON array of session IDs\n    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,\n    created_at TEXT DEFAULT (datetime('now')),\n    updated_at TEXT DEFAULT (datetime('now'))\n)",
    # table: canvas_annotations
    "CREATE TABLE canvas_annotations (\n    id TEXT PRIMARY KEY,\n    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,\n    canvas_id TEXT NOT NULL,\n    kind TEXT NOT NULL,\n    target_id TEXT,\n    coords_json TEXT,\n    text TEXT,\n    color TEXT,\n    author TEXT DEFAULT 'model',\n    created_at TEXT DEFAULT (datetime('now'))\n)",
    # table: cascade_runs
    "CREATE TABLE cascade_runs (\n    id TEXT PRIMARY KEY,\n    cascade_id TEXT,                           -- optional ref to saved cascade\n    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,\n    status TEXT DEFAULT 'running',             -- running | paused | waiting_idle | completed | failed | stopped\n    current_step INTEGER DEFAULT 0,\n    iteration INTEGER DEFAULT 0,\n    steps TEXT NOT NULL DEFAULT '[]',          -- JSON: resolved (substituted) prompt strings\n    original_steps TEXT,                       -- JSON: unsubstituted for loop re-prompt\n    loop INTEGER DEFAULT 0,\n    auto_approve INTEGER DEFAULT 0,\n    bypass_permissions INTEGER DEFAULT 0,\n    auto_approve_plan INTEGER DEFAULT 0,\n    variables TEXT DEFAULT '[]',               -- JSON: variable metadata\n    variable_values TEXT DEFAULT '{}',         -- JSON: current variable values\n    loop_reprompt INTEGER DEFAULT 0,\n    error TEXT,\n    started_at TEXT DEFAULT (datetime('now')),\n    completed_at TEXT\n)",
    # table: cascades
    "CREATE TABLE cascades (\n    id TEXT PRIMARY KEY,\n    name TEXT NOT NULL,\n    steps TEXT NOT NULL DEFAULT '[]',      -- JSON array of prompt strings\n    loop INTEGER DEFAULT 0,\n    auto_approve INTEGER DEFAULT 0,        -- restart session in auto-approve mode\n    bypass_permissions INTEGER DEFAULT 0,  -- restart session with full bypass (dangerous)\n    usage_count INTEGER DEFAULT 0,\n    is_quickaction INTEGER DEFAULT 0,\n    quickaction_order INTEGER DEFAULT 0,\n    icon TEXT,\n    color TEXT,\n    created_at TEXT DEFAULT (datetime('now')),\n    updated_at TEXT\n, auto_approve_plan INTEGER DEFAULT 0, variables TEXT DEFAULT '[]', loop_reprompt INTEGER DEFAULT 0)",
    # table: command_log
    "CREATE TABLE command_log (\n    id INTEGER PRIMARY KEY AUTOINCREMENT,\n    session_id TEXT,\n    workspace_id TEXT,\n    command TEXT NOT NULL,\n    created_at TEXT DEFAULT (datetime('now'))\n)",
    # table: commander_events
    "CREATE TABLE commander_events (\n    id INTEGER PRIMARY KEY AUTOINCREMENT,\n    event_type TEXT NOT NULL,                -- CommanderEvent value (e.g. \"task_completed\")\n    source TEXT NOT NULL DEFAULT 'commander',-- where the event originated (commander|api|mcp|plugin|hook)\n    payload TEXT,                            -- JSON-encoded event-specific data\n    workspace_id TEXT,                       -- denormalized for fast filtering\n    session_id TEXT,                         -- denormalized\n    task_id TEXT,                            -- denormalized\n    actor TEXT,                              -- \"user\" | \"commander\" | \"plugin:<id>\" | ...\n    created_at TEXT DEFAULT (datetime('now'))\n)",
    # table: commit_attributions
    "CREATE TABLE commit_attributions (\n    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,\n    repo_path TEXT NOT NULL,\n    commit_sha TEXT NOT NULL,\n    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,\n    session_key TEXT NOT NULL,\n    task_id_snapshot TEXT REFERENCES tasks(id) ON DELETE SET NULL,\n    active_ticket_id_snapshot TEXT REFERENCES tasks(id) ON DELETE SET NULL,\n    session_name_snapshot TEXT,\n    session_cli_type_snapshot TEXT,\n    session_model_snapshot TEXT,\n    session_type_snapshot TEXT,\n    command_kind TEXT,\n    old_head TEXT,\n    new_head TEXT,\n    source TEXT DEFAULT 'git_wrapper',\n    created_at TEXT DEFAULT (datetime('now')),\n    PRIMARY KEY (workspace_id, repo_path, commit_sha)\n)",
    # table: device_challenges
    "CREATE TABLE device_challenges (\n    nonce TEXT PRIMARY KEY,                    -- 32 bytes base64url\n    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,\n    issued_at TEXT DEFAULT (datetime('now')),\n    expires_at TEXT NOT NULL,                  -- issued_at + 5 min\n    consumed_at TEXT\n)",
    # table: devices
    "CREATE TABLE devices (\n    id TEXT PRIMARY KEY,\n    label TEXT NOT NULL,\n    public_key TEXT NOT NULL,                  -- Ed25519 pubkey, base64url (raw 32 bytes)\n    fingerprint TEXT NOT NULL UNIQUE,          -- SHA-256(pubkey_bytes) hex\n    user_agent TEXT,\n    paired_at TEXT DEFAULT (datetime('now')),\n    last_seen_at TEXT DEFAULT (datetime('now')),\n    revoked_at TEXT\n)",
    # table: event_subscriptions
    "CREATE TABLE event_subscriptions (\n    id TEXT PRIMARY KEY,\n    name TEXT NOT NULL,\n    event_types TEXT NOT NULL,               -- CSV of CommanderEvent values or \"*\"\n    workspace_id TEXT,                        -- optional scope\n    delivery_type TEXT NOT NULL DEFAULT 'webhook',  -- webhook | plugin | log\n    webhook_url TEXT,                         -- for delivery_type=webhook\n    webhook_secret TEXT,                      -- optional HMAC signing secret\n    plugin_id TEXT REFERENCES plugins(id) ON DELETE CASCADE,  -- for delivery_type=plugin\n    enabled INTEGER DEFAULT 1,\n    created_by TEXT,                          -- \"user\" | \"plugin:<id>\"\n    delivery_count INTEGER DEFAULT 0,\n    last_delivery_at TEXT,\n    last_delivery_status TEXT,                -- ok | error | pending\n    last_delivery_error TEXT,\n    created_at TEXT DEFAULT (datetime('now'))\n)",
    # table: external_access_log
    "CREATE TABLE external_access_log (\n    id INTEGER PRIMARY KEY AUTOINCREMENT,\n    session_id TEXT,\n    workspace_id TEXT,\n    tool_name TEXT NOT NULL,\n    url TEXT NOT NULL,\n    domain TEXT,\n    source_type TEXT DEFAULT 'unknown',\n    created_at TEXT DEFAULT (datetime('now'))\n)",
    # table: file_activity
    "CREATE TABLE file_activity (\n    id INTEGER PRIMARY KEY AUTOINCREMENT,\n    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,\n    file_path TEXT NOT NULL,\n    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,\n    session_name TEXT,\n    task_summary TEXT,\n    task_title TEXT,\n    tool_name TEXT,\n    created_at TEXT DEFAULT (datetime('now'))\n)",
    # table: file_claims
    "CREATE TABLE file_claims ( id TEXT PRIMARY KEY, workspace_id TEXT, path TEXT NOT NULL, session_id TEXT, agent_id TEXT, intent TEXT, acquired_at TEXT DEFAULT (datetime('now')), expires_at TEXT NOT NULL, released_at TEXT)",
    # table: grid_templates
    "CREATE TABLE grid_templates (\n    id TEXT PRIMARY KEY,\n    name TEXT NOT NULL,\n    cols INTEGER NOT NULL DEFAULT 3,\n    cells TEXT NOT NULL DEFAULT '[]',              -- JSON: [{ id, col, row, colSpan, rowSpan }]\n    cell_assignments TEXT NOT NULL DEFAULT '{}',   -- JSON: { [cellId]: sessionId }\n    created_at TEXT DEFAULT (datetime('now')),\n    updated_at TEXT DEFAULT (datetime('now'))\n, workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE)",
    # table: guideline_contributions
    "CREATE TABLE guideline_contributions (\n    guideline_id TEXT NOT NULL REFERENCES guidelines(id) ON DELETE CASCADE,\n    extension_id TEXT NOT NULL,\n    contribution_key TEXT NOT NULL,\n    content TEXT NOT NULL,\n    PRIMARY KEY (guideline_id, extension_id, contribution_key)\n)",
    # table: guidelines
    "CREATE TABLE guidelines (\n    id TEXT PRIMARY KEY,\n    name TEXT NOT NULL,\n    content TEXT NOT NULL,\n    is_default INTEGER DEFAULT 0,\n    created_at TEXT DEFAULT (datetime('now')),\n    updated_at TEXT\n, when_to_use TEXT, is_builtin INTEGER DEFAULT 0)",
    # table: install_script_allowlist
    "CREATE TABLE install_script_allowlist (\n    id INTEGER PRIMARY KEY AUTOINCREMENT,\n    package TEXT NOT NULL,\n    ecosystem TEXT NOT NULL,\n    reason TEXT DEFAULT '',\n    created_at TEXT DEFAULT (datetime('now')),\n    UNIQUE(package, ecosystem)\n)",
    # table: invites
    "CREATE TABLE invites (\n    id TEXT PRIMARY KEY,\n    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,\n    token_hash TEXT NOT NULL UNIQUE,\n    encoded_speakable TEXT,\n    encoded_compact TEXT,\n    mode TEXT NOT NULL,\n    brief_subscope TEXT,\n    ttl_seconds INTEGER NOT NULL,\n    label TEXT,\n    redemption_attempts INTEGER NOT NULL DEFAULT 0,\n    redeemed_at TEXT,\n    redeemed_by_session_id TEXT,\n    burned_at TEXT,\n    expires_at TEXT NOT NULL,\n    created_at TEXT DEFAULT (datetime('now')),\n    created_by TEXT\n)",
    # table: joiner_sessions
    "CREATE TABLE joiner_sessions (\n    id TEXT PRIMARY KEY,\n    token_hash TEXT NOT NULL UNIQUE,           -- SHA-256 of cookie value\n    invite_id TEXT REFERENCES invites(id) ON DELETE SET NULL,\n    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,\n    label TEXT,\n    mode TEXT NOT NULL,                        -- 'brief' | 'code' | 'full'\n    brief_subscope TEXT,\n    ttl_seconds INTEGER NOT NULL,\n    actor_kind TEXT NOT NULL,                  -- 'owner_legacy' | 'owner_device' | 'joiner_session'\n    device_id TEXT,                            -- (PR2-future) FK to devices(id)\n    created_at TEXT DEFAULT (datetime('now')),\n    last_used_at TEXT DEFAULT (datetime('now')),\n    expires_at TEXT NOT NULL,                  -- slides each request, capped at hard_cap_at\n    hard_cap_at TEXT NOT NULL,                 -- created_at + 90d\n    revoked_at TEXT,\n    last_ip TEXT,\n    last_user_agent TEXT\n)",
    # table: mcp_servers
    "CREATE TABLE mcp_servers (\n    id TEXT PRIMARY KEY,\n    name TEXT NOT NULL,\n    server_name TEXT NOT NULL UNIQUE,\n    description TEXT,\n    server_type TEXT DEFAULT 'stdio',\n    command TEXT NOT NULL,\n    args TEXT,\n    env TEXT,\n    auto_approve INTEGER DEFAULT 0,\n    default_enabled INTEGER DEFAULT 0,\n    is_builtin INTEGER DEFAULT 0,\n    created_at TEXT DEFAULT (datetime('now')),\n    updated_at TEXT\n)",
    # table: memory_entries
    "CREATE TABLE memory_entries (\n    id TEXT PRIMARY KEY,\n    workspace_id TEXT,\n    name TEXT NOT NULL,\n    type TEXT NOT NULL,\n    description TEXT DEFAULT '',\n    content TEXT NOT NULL,\n    source_cli TEXT DEFAULT 'commander',\n    tags TEXT DEFAULT '[]',\n    created_at TEXT NOT NULL DEFAULT (datetime('now')),\n    updated_at TEXT NOT NULL DEFAULT (datetime('now'))\n, auto INTEGER DEFAULT 0, confidence REAL DEFAULT 1.0)",
    # table: messages
    "CREATE TABLE messages (\n    id INTEGER PRIMARY KEY AUTOINCREMENT,\n    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,\n    role TEXT NOT NULL,\n    content TEXT,\n    thinking TEXT,\n    tool_calls TEXT,\n    cost_usd REAL DEFAULT 0,\n    duration_ms INTEGER DEFAULT 0,\n    created_at TEXT DEFAULT (datetime('now'))\n)",
    # table: observatory_findings
    "CREATE TABLE observatory_findings (\n    id TEXT PRIMARY KEY,\n    workspace_id TEXT,\n    source TEXT NOT NULL,\n    source_url TEXT,\n    title TEXT NOT NULL,\n    description TEXT,\n    category TEXT DEFAULT 'integrate',\n    relevance_score REAL DEFAULT 0,\n    proposal TEXT,\n    steal_targets TEXT DEFAULT '[]',\n    tags TEXT DEFAULT '[]',\n    notes TEXT,\n    status TEXT DEFAULT 'new',\n    promoted_task_id TEXT,\n    metadata TEXT DEFAULT '{}',\n    scan_id TEXT,\n    created_at TEXT DEFAULT (datetime('now')),\n    updated_at TEXT DEFAULT (datetime('now'))\n, verdict TEXT, triage_reason TEXT, voice TEXT DEFAULT '{}', extracted_url TEXT, extracted_chars INTEGER DEFAULT 0, target_id TEXT)",
    # table: observatory_insights
    "CREATE TABLE observatory_insights (\n    id TEXT PRIMARY KEY,\n    scope TEXT NOT NULL DEFAULT 'workspace' CHECK (scope IN ('workspace', 'company')),\n    workspace_id TEXT,\n    insight_type TEXT NOT NULL,        -- 'competitor' | 'pain_point' | 'feature_gap' | 'integration_done'\n    name TEXT NOT NULL,                -- short canonical name (LLM dedupes against this)\n    summary TEXT NOT NULL,             -- 1-2 sentence prose\n    evidence TEXT DEFAULT '[]',        -- JSON array of finding_ids\n    strength REAL DEFAULT 0.5,         -- 0..1, smoothed; grows with corroborating findings\n    last_seen_at TEXT,\n    created_at TEXT DEFAULT (datetime('now')),\n    updated_at TEXT DEFAULT (datetime('now'))\n)",
    # table: observatory_profiles
    "CREATE TABLE observatory_profiles (\n    id TEXT PRIMARY KEY,\n    scope TEXT NOT NULL DEFAULT 'workspace' CHECK (scope IN ('workspace', 'company')),\n    workspace_id TEXT,\n    profile TEXT NOT NULL DEFAULT '{}',\n    last_recalibration_notes TEXT DEFAULT '',\n    inputs_hash TEXT,\n    generated_at TEXT,\n    user_edited_at TEXT,\n    created_at TEXT DEFAULT (datetime('now')),\n    updated_at TEXT DEFAULT (datetime('now'))\n)",
    # table: observatory_scans
    "CREATE TABLE observatory_scans (\n    id TEXT PRIMARY KEY,\n    workspace_id TEXT,\n    source TEXT NOT NULL,\n    status TEXT DEFAULT 'pending',\n    findings_count INTEGER DEFAULT 0,\n    error TEXT,\n    started_at TEXT,\n    completed_at TEXT\n)",
    # table: observatory_search_targets
    "CREATE TABLE observatory_search_targets (\n    id TEXT PRIMARY KEY,\n    scope TEXT NOT NULL DEFAULT 'workspace' CHECK (scope IN ('workspace', 'company')),\n    workspace_id TEXT,\n    source TEXT NOT NULL,\n    target_type TEXT NOT NULL,\n    value TEXT NOT NULL,\n    rationale TEXT,\n    status TEXT DEFAULT 'active',\n    added_by TEXT,\n    hit_count INTEGER DEFAULT 0,\n    yield_count INTEGER DEFAULT 0,\n    signal_score REAL DEFAULT 0.5,\n    last_scanned_at TEXT,\n    last_yielded_at TEXT,\n    created_at TEXT DEFAULT (datetime('now')),\n    updated_at TEXT DEFAULT (datetime('now')),\n    UNIQUE(workspace_id, source, target_type, value)\n)",
    # table: observatory_sources
    "CREATE TABLE observatory_sources (\n    workspace_id TEXT NOT NULL DEFAULT '__global__',\n    source TEXT NOT NULL,\n    enabled INTEGER DEFAULT 0,\n    interval_hours INTEGER DEFAULT 24,\n    mode TEXT DEFAULT 'both',\n    keywords TEXT DEFAULT '[]',\n    last_scan_at TEXT,\n    PRIMARY KEY (workspace_id, source)\n)",
    # table: output_captures
    "CREATE TABLE output_captures (\n    id INTEGER PRIMARY KEY AUTOINCREMENT,\n    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,\n    capture_type TEXT NOT NULL,\n    tool_name TEXT,\n    content TEXT,\n    raw_text TEXT,\n    status TEXT DEFAULT 'pending',\n    created_at TEXT DEFAULT (datetime('now'))\n)",
    # table: package_scans
    "CREATE TABLE package_scans (\n    id INTEGER PRIMARY KEY AUTOINCREMENT,\n    session_id TEXT,\n    workspace_id TEXT,\n    package TEXT NOT NULL,\n    ecosystem TEXT NOT NULL,\n    version TEXT DEFAULT '',\n    age_days INTEGER DEFAULT -1,\n    status TEXT DEFAULT 'ok',\n    vuln_count INTEGER DEFAULT 0,\n    vuln_critical INTEGER DEFAULT 0,\n    known_malware INTEGER DEFAULT 0,\n    decision TEXT DEFAULT 'allow',\n    reason TEXT DEFAULT '',\n    advisories TEXT DEFAULT '[]',\n    install_scripts TEXT DEFAULT '',\n    llm_verdict TEXT DEFAULT '',\n    fallback TEXT DEFAULT '',\n    created_at TEXT DEFAULT (datetime('now'))\n)",
    # table: peer_messages
    "CREATE TABLE peer_messages (\n    id TEXT PRIMARY KEY,\n    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,\n    from_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,\n    topic TEXT NOT NULL DEFAULT 'general',\n    content TEXT NOT NULL,\n    priority TEXT DEFAULT 'info',\n    files TEXT DEFAULT '[]',\n    read_by TEXT DEFAULT '[]',\n    created_at TEXT DEFAULT (datetime('now'))\n, blocking INTEGER DEFAULT 0, in_reply_to TEXT, reply_received INTEGER DEFAULT 0)",
    # table: pipeline_definitions
    "CREATE TABLE pipeline_definitions (\n    id TEXT PRIMARY KEY,\n    name TEXT NOT NULL DEFAULT 'Untitled Pipeline',\n    description TEXT DEFAULT '',\n    workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,\n    stages TEXT DEFAULT '[]',\n    transitions TEXT DEFAULT '[]',\n    triggers TEXT DEFAULT '[]',\n    preset INTEGER DEFAULT 0,\n    preset_key TEXT UNIQUE,\n    status TEXT DEFAULT 'draft',\n    created_at TEXT DEFAULT (datetime('now')),\n    updated_at TEXT DEFAULT (datetime('now'))\n)",
    # table: pipeline_runs
    "CREATE TABLE pipeline_runs (\n    id TEXT PRIMARY KEY,\n    pipeline_id TEXT REFERENCES pipeline_definitions(id) ON DELETE CASCADE,\n    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,\n    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,\n    status TEXT DEFAULT 'pending',\n    current_stages TEXT DEFAULT '[]',\n    iteration INTEGER DEFAULT 1,\n    max_iterations INTEGER DEFAULT 20,\n    variables TEXT DEFAULT '{}',\n    stage_history TEXT DEFAULT '{}',\n    trigger_type TEXT DEFAULT 'manual',\n    error TEXT,\n    started_at TEXT DEFAULT (datetime('now')),\n    completed_at TEXT,\n    created_at TEXT DEFAULT (datetime('now')),\n    updated_at TEXT DEFAULT (datetime('now'))\n, budget_tokens INTEGER, budget_wall_s INTEGER, spent_tokens INTEGER DEFAULT 0)",
    # table: plugin_components
    "CREATE TABLE plugin_components (\n    id TEXT PRIMARY KEY,\n    plugin_id TEXT REFERENCES plugins(id) ON DELETE CASCADE,\n    type TEXT NOT NULL,                   -- 'guideline' or 'script'\n    name TEXT NOT NULL,\n    description TEXT,\n    content TEXT,                         -- guideline text OR script source\n    activation TEXT DEFAULT 'always',     -- 'always' (system prompt) or 'on_demand' (disk skill)\n    trigger TEXT,                         -- for scripts: session_start, prompt_submit, etc.\n    permissions TEXT,                     -- JSON array\n    ai_explanation TEXT,                  -- generated on-demand for scripts\n    risk_level TEXT,                      -- 'low', 'medium', 'high'\n    skippable INTEGER DEFAULT 1,\n    order_index INTEGER DEFAULT 0,\n    created_at TEXT DEFAULT (datetime('now'))\n)",
    # table: plugin_registries
    "CREATE TABLE plugin_registries (\n    id TEXT PRIMARY KEY,\n    name TEXT NOT NULL,\n    url TEXT NOT NULL UNIQUE,\n    enabled INTEGER DEFAULT 1,\n    is_builtin INTEGER DEFAULT 0,        -- 1 = preconfigured, can disable but not delete\n    last_synced_at TEXT,\n    last_sync_status TEXT,                -- 'ok', 'error', 'never'\n    last_sync_error TEXT,\n    plugin_count INTEGER DEFAULT 0,\n    order_index INTEGER DEFAULT 0,\n    created_at TEXT DEFAULT (datetime('now'))\n)",
    # table: plugins
    "CREATE TABLE plugins (\n    id TEXT PRIMARY KEY,                  -- plugin's own id from registry\n    registry_id TEXT REFERENCES plugin_registries(id) ON DELETE SET NULL,\n    name TEXT NOT NULL,\n    version TEXT,\n    description TEXT,\n    author TEXT,\n    license TEXT,\n    source_url TEXT,                      -- upstream (GitHub, etc.)\n    source_format TEXT,                   -- 'skill_md', 'cursorrules', 'claude_md', 'gemini_md', etc.\n    categories TEXT,                      -- JSON array\n    tags TEXT,                            -- JSON array\n    security_tier INTEGER DEFAULT 0,      -- 0=text-only, 1=sandboxed, 2=extended, 3=unverified\n    contains_scripts INTEGER DEFAULT 0,\n    rating REAL,\n    install_count INTEGER DEFAULT 0,\n    package_url TEXT,                     -- where the full package can be downloaded\n    package_data TEXT,                    -- JSON: full plugin.yaml content (after install)\n    checksum TEXT,\n    installed INTEGER DEFAULT 0,\n    installed_at TEXT,\n    scripts_approved INTEGER DEFAULT 0,\n    skipped_components TEXT,              -- JSON array of component ids the user opted out of\n    created_at TEXT DEFAULT (datetime('now')),\n    updated_at TEXT DEFAULT (datetime('now'))\n)",
    # table: port_leases
    "CREATE TABLE port_leases (\n    id TEXT PRIMARY KEY,\n    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,\n    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,\n    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,\n    port INTEGER NOT NULL,\n    host TEXT DEFAULT '127.0.0.1',\n    label TEXT,\n    status TEXT DEFAULT 'active',\n    preview_url TEXT,\n    metadata TEXT DEFAULT '{}',\n    created_at TEXT DEFAULT (datetime('now')),\n    updated_at TEXT DEFAULT (datetime('now')),\n    expires_at TEXT,\n    released_at TEXT\n)",
    # table: prompts
    "CREATE TABLE prompts (\n    id TEXT PRIMARY KEY,\n    name TEXT NOT NULL,\n    category TEXT DEFAULT 'General',\n    content TEXT NOT NULL,\n    variables TEXT,\n    tags TEXT,\n    usage_count INTEGER DEFAULT 0,\n    pinned INTEGER DEFAULT 0,\n    is_quickaction INTEGER DEFAULT 0,\n    quickaction_order INTEGER DEFAULT 0,\n    icon TEXT,\n    color TEXT,\n    source_type TEXT,\n    source_url TEXT,\n    created_at TEXT DEFAULT (datetime('now')),\n    updated_at TEXT\n, mcp_server_ids TEXT)",
    # table: push_subscriptions
    "CREATE TABLE push_subscriptions (\n    id TEXT PRIMARY KEY,\n    actor_kind TEXT NOT NULL,                  -- 'owner_legacy' | 'owner_device' | 'joiner_session'\n    actor_id TEXT,                             -- joiner_sessions.id, or NULL for owner_legacy\n    endpoint TEXT NOT NULL,\n    p256dh TEXT NOT NULL,\n    auth TEXT NOT NULL,\n    user_agent TEXT,\n    created_at TEXT DEFAULT (datetime('now')),\n    last_used_at TEXT,\n    UNIQUE(actor_kind, actor_id, endpoint)\n)",
    # table: research_entries
    "CREATE TABLE research_entries (\n    id TEXT PRIMARY KEY,\n    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,\n    scope TEXT NOT NULL DEFAULT 'workspace' CHECK (scope IN ('workspace', 'company')),\n    topic TEXT NOT NULL,\n    query TEXT,\n    feature_tag TEXT,\n    modes TEXT NOT NULL DEFAULT '[]',\n    status TEXT DEFAULT 'pending',\n    findings_summary TEXT,\n    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,\n    request_id TEXT,\n    created_at TEXT DEFAULT (datetime('now')),\n    updated_at TEXT DEFAULT (datetime('now'))\n, artifact_run_id TEXT, artifact_workspace_id TEXT)",
    # table: research_schedules
    "CREATE TABLE research_schedules (\n    id TEXT PRIMARY KEY,\n    scope TEXT NOT NULL DEFAULT 'workspace' CHECK (scope IN ('workspace', 'company')),\n    workspace_id TEXT,\n    context_workspace_id TEXT,\n    query TEXT NOT NULL,\n    modes TEXT NOT NULL DEFAULT '[\"technical_decision\"]',\n    plan TEXT DEFAULT '{}',\n    depth TEXT NOT NULL DEFAULT 'standard',\n    cross_temporal INTEGER NOT NULL DEFAULT 0,\n    interval_hours INTEGER DEFAULT 24,\n    enabled INTEGER DEFAULT 1,\n    last_run_at TEXT,\n    next_run_at TEXT,\n    last_job_id TEXT,\n    created_at TEXT DEFAULT (datetime('now')),\n    updated_at TEXT DEFAULT (datetime('now'))\n)",
    # table: research_sources
    "CREATE TABLE research_sources (\n    id INTEGER PRIMARY KEY AUTOINCREMENT,\n    entry_id TEXT REFERENCES research_entries(id) ON DELETE CASCADE,\n    url TEXT,\n    title TEXT,\n    content_summary TEXT,\n    raw_content TEXT,\n    relevance_score REAL DEFAULT 0,\n    created_at TEXT DEFAULT (datetime('now'))\n)",
    # table: safety_approval_grants
    "CREATE TABLE safety_approval_grants (\n    nonce TEXT PRIMARY KEY,\n    decision_id INTEGER NOT NULL UNIQUE\n        REFERENCES safety_decisions(id) ON DELETE CASCADE,\n    token_hash TEXT NOT NULL UNIQUE,\n    actor_kind TEXT NOT NULL,\n    actor_id TEXT NOT NULL,\n    workspace_id TEXT NOT NULL,\n    session_id TEXT NOT NULL,\n    rule_id TEXT NOT NULL,\n    operation_digest TEXT NOT NULL,\n    token_expires_at INTEGER NOT NULL,\n    callback_consumed_at TEXT,\n    approved_at TEXT,\n    approval_expires_at INTEGER,\n    operation_consumed_at TEXT,\n    created_at TEXT DEFAULT (datetime('now'))\n)",
    # table: safety_decisions
    "CREATE TABLE safety_decisions (\n    id INTEGER PRIMARY KEY AUTOINCREMENT,\n    tool_use_id TEXT,\n    session_id TEXT,\n    workspace_id TEXT NOT NULL,\n    tool_name TEXT NOT NULL,\n    tool_input_summary TEXT,\n    matched_rule_id TEXT,\n    decision TEXT NOT NULL,\n    reason TEXT,\n    user_response TEXT,\n    latency_ms INTEGER,\n    script_content TEXT,\n    precedent_decision_ids TEXT,\n    precedent_reason TEXT,\n    precedent_class TEXT,\n    precedent_mode TEXT,\n    precedent_eligible INTEGER NOT NULL DEFAULT 1\n        CHECK (precedent_eligible IN (0, 1)),\n    created_at TEXT DEFAULT (datetime('now'))\n)",
    # table: safety_rules
    "CREATE TABLE safety_rules (\n    id TEXT PRIMARY KEY,\n    name TEXT NOT NULL,\n    description TEXT DEFAULT '',\n    category TEXT NOT NULL,\n    severity TEXT NOT NULL,\n    tool_match TEXT NOT NULL,\n    pattern TEXT NOT NULL,\n    pattern_field TEXT DEFAULT '',\n    action TEXT NOT NULL DEFAULT 'deny',\n    enabled INTEGER DEFAULT 1,\n    is_builtin INTEGER DEFAULT 0,\n    workspace_id TEXT,\n    created_at TEXT DEFAULT (datetime('now')),\n    updated_at TEXT DEFAULT (datetime('now'))\n)",
    # table: script_approvals
    "CREATE TABLE script_approvals (\n    id TEXT PRIMARY KEY,\n    script_hash TEXT NOT NULL,\n    script_description TEXT NOT NULL,\n    script_excerpt TEXT NOT NULL,\n    tool_use_id TEXT,\n    workspace_id TEXT,\n    approved_at TEXT DEFAULT (datetime('now'))\n)",
    # table: secure_decisions
    "CREATE TABLE secure_decisions (\n    id TEXT PRIMARY KEY,\n    run_id TEXT NOT NULL,\n    session_id TEXT,\n    command TEXT NOT NULL DEFAULT '',\n    decision TEXT NOT NULL DEFAULT 'ask',     -- allow|ask|deny\n    reason TEXT DEFAULT '',\n    confidence REAL DEFAULT 0,\n    scope_hash TEXT DEFAULT '',\n    cached INTEGER DEFAULT 0,\n    created_at TEXT NOT NULL DEFAULT (datetime('now'))\n)",
    # table: secure_findings
    "CREATE TABLE secure_findings (\n    id TEXT PRIMARY KEY,\n    run_id TEXT NOT NULL,\n    session_id TEXT,\n    title TEXT NOT NULL,\n    severity TEXT DEFAULT 'info',             -- info|low|medium|high|critical\n    detail TEXT DEFAULT '',\n    reproduction TEXT DEFAULT '',\n    target_ip TEXT DEFAULT '',\n    created_at TEXT NOT NULL DEFAULT (datetime('now'))\n)",
    # table: secure_runs
    "CREATE TABLE secure_runs (\n    run_id TEXT PRIMARY KEY,\n    session_id TEXT,\n    workspace_id TEXT,\n    scope_json TEXT NOT NULL DEFAULT '{}',\n    scope_hash TEXT DEFAULT '',\n    status TEXT NOT NULL DEFAULT 'pending',   -- pending|provisioning|active|killed|torndown|error\n    inner_subnet TEXT DEFAULT '',\n    kali_ip TEXT DEFAULT '',\n    gateway_ip TEXT DEFAULT '',\n    error TEXT DEFAULT '',\n    created_at TEXT NOT NULL DEFAULT (datetime('now')),\n    updated_at TEXT NOT NULL DEFAULT (datetime('now'))\n)",
    # table: session_digests
    "CREATE TABLE session_digests (\n    id TEXT PRIMARY KEY,\n    session_id TEXT UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,\n    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,\n    task_summary TEXT DEFAULT '',\n    current_focus TEXT DEFAULT '',\n    files_touched TEXT DEFAULT '[]',\n    decisions TEXT DEFAULT '[]',\n    discoveries TEXT DEFAULT '[]',\n    context_health TEXT DEFAULT 'unknown',\n    reuse_notes TEXT DEFAULT '{}',\n    last_summary_at TEXT,\n    summary_model TEXT,\n    updated_at TEXT DEFAULT (datetime('now'))\n)",
    # table: session_git_identities
    "CREATE TABLE session_git_identities (\n    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,\n    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,\n    session_key TEXT NOT NULL,\n    key_version TEXT NOT NULL DEFAULT 'v1',\n    created_at TEXT DEFAULT (datetime('now')),\n    PRIMARY KEY (workspace_id, session_id),\n    UNIQUE (workspace_id, session_key)\n)",
    # table: session_guidelines
    "CREATE TABLE session_guidelines (\n    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,\n    guideline_id TEXT REFERENCES guidelines(id) ON DELETE CASCADE,\n    PRIMARY KEY (session_id, guideline_id)\n)",
    # table: session_mcp_servers
    "CREATE TABLE session_mcp_servers (\n    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,\n    mcp_server_id TEXT REFERENCES mcp_servers(id) ON DELETE CASCADE,\n    auto_approve_override INTEGER,\n    PRIMARY KEY (session_id, mcp_server_id)\n)",
    # table: session_plugin_components
    "CREATE TABLE session_plugin_components (\n    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,\n    component_id TEXT REFERENCES plugin_components(id) ON DELETE CASCADE,\n    PRIMARY KEY (session_id, component_id)\n)",
    # table: session_turn_summaries
    "CREATE TABLE session_turn_summaries (\n    id TEXT PRIMARY KEY,\n    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,\n    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,\n    summary TEXT NOT NULL,\n    created_at TEXT DEFAULT (datetime('now'))\n)",
    # table: sessions
    "CREATE TABLE sessions (\n    id TEXT PRIMARY KEY,\n    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,\n    name TEXT,\n    model TEXT DEFAULT 'sonnet',\n    permission_mode TEXT DEFAULT 'default',\n    effort TEXT DEFAULT 'high',\n    budget_usd REAL,\n    system_prompt TEXT,\n    allowed_tools TEXT,\n    disallowed_tools TEXT,\n    add_dirs TEXT,\n    agent TEXT,\n    worktree INTEGER DEFAULT 0,\n    mcp_config TEXT,\n    turn_count INTEGER DEFAULT 0,\n    total_cost_usd REAL DEFAULT 0,\n    status TEXT DEFAULT 'idle',\n    is_imported INTEGER DEFAULT 0,\n    session_type TEXT DEFAULT 'worker',\n    parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,\n    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,\n    scratchpad TEXT,\n    account_id TEXT REFERENCES accounts(id),\n    native_session_id TEXT,\n    native_slug TEXT,\n    auto_approve_mcp INTEGER DEFAULT 0,\n    cli_type TEXT DEFAULT 'claude',\n    cli_profile_migrated_from TEXT,\n    cli_runtime_home TEXT,\n    cli_run_lineage TEXT DEFAULT '[]',\n    output_style TEXT,\n    order_index INTEGER DEFAULT 0,\n    created_at TEXT DEFAULT (datetime('now')),\n    last_active_at TEXT\n, active_guideline_ids TEXT, active_mcp_server_ids TEXT, plan_model TEXT, execute_model TEXT, auto_approve_plan INTEGER DEFAULT 0, is_external INTEGER DEFAULT 0, external_pid TEXT, purpose TEXT, tags TEXT DEFAULT '[]', worktree_path TEXT, branch_group TEXT, branch_label TEXT, archived INTEGER DEFAULT 0, summary TEXT, memory_injected_info TEXT, owner_actor_kind TEXT, owner_actor_id TEXT, owner_mode TEXT, active_ticket_id TEXT, board_action TEXT, board_action_at TEXT, board_action_note TEXT)",
    # table: tab_groups
    "CREATE TABLE tab_groups (\n    id TEXT PRIMARY KEY,\n    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,\n    name TEXT NOT NULL,\n    session_ids TEXT NOT NULL DEFAULT '[]',   -- JSON array of session IDs\n    is_active INTEGER DEFAULT 0,\n    created_at TEXT DEFAULT (datetime('now')),\n    updated_at TEXT DEFAULT (datetime('now'))\n)",
    # table: task_dispatch_intents
    "CREATE TABLE task_dispatch_intents (\n    id TEXT PRIMARY KEY,\n    task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,\n    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,\n    mode TEXT DEFAULT 'commander',\n    target_session_id TEXT,\n    payload TEXT DEFAULT '{}',\n    status TEXT DEFAULT 'pending',\n    last_error TEXT,\n    created_at TEXT DEFAULT (datetime('now')),\n    updated_at TEXT DEFAULT (datetime('now')),\n    dispatched_at TEXT\n)",
    # table: task_events
    "CREATE TABLE task_events (\n    id INTEGER PRIMARY KEY AUTOINCREMENT,\n    task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,\n    event_type TEXT NOT NULL,\n    actor TEXT,\n    old_value TEXT,\n    new_value TEXT,\n    message TEXT,\n    created_at TEXT DEFAULT (datetime('now'))\n)",
    # table: tasks
    "CREATE TABLE tasks (\n    id TEXT PRIMARY KEY,\n    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,\n    title TEXT NOT NULL,\n    description TEXT,\n    acceptance_criteria TEXT,\n    status TEXT DEFAULT 'backlog',\n    priority INTEGER DEFAULT 0,\n    sort_order REAL DEFAULT 0,\n    assigned_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,\n    commander_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,\n    parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,\n    labels TEXT,\n    result_summary TEXT,\n    scratchpad TEXT,\n    plan_first INTEGER DEFAULT 0,\n    auto_approve_plan INTEGER DEFAULT 0,\n    ralph_loop INTEGER DEFAULT 0,\n    ralph_iteration INTEGER DEFAULT 0,\n    ralph_phase TEXT,\n    deep_research INTEGER DEFAULT 0,\n    test_with_agent INTEGER DEFAULT 0,\n    blocked_on_research_id TEXT REFERENCES research_entries(id) ON DELETE SET NULL,\n    created_at TEXT DEFAULT (datetime('now')),\n    updated_at TEXT DEFAULT (datetime('now')),\n    started_at TEXT,\n    completed_at TEXT\n, lessons_learned TEXT, important_notes TEXT, iteration INTEGER DEFAULT 1, last_agent_session_id TEXT, iteration_history TEXT, queued_for_session_id TEXT, queue_order INTEGER DEFAULT 0, pipeline INTEGER DEFAULT 0, pipeline_max_iterations INTEGER DEFAULT 5, pipeline_stage TEXT, depends_on TEXT DEFAULT '[]', seam_contract TEXT, phase INTEGER DEFAULT 0, tier TEXT, blueprint_path TEXT, blueprint_status TEXT, elements TEXT)",
    # table: templates
    "CREATE TABLE templates (\n    id TEXT PRIMARY KEY,\n    name TEXT NOT NULL,\n    model TEXT,\n    permission_mode TEXT,\n    effort TEXT,\n    budget_usd REAL,\n    system_prompt TEXT,\n    allowed_tools TEXT,\n    disallowed_tools TEXT,\n    guideline_ids TEXT,\n    conversation_turns TEXT,\n    account_id TEXT REFERENCES accounts(id),\n    cli_type TEXT DEFAULT 'claude',\n    created_at TEXT DEFAULT (datetime('now'))\n, mcp_server_ids TEXT, plan_model TEXT, execute_model TEXT, auto_approve_plan INTEGER DEFAULT 0)",
    # table: test_queue
    "CREATE TABLE test_queue (\n    id TEXT PRIMARY KEY,\n    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,\n    task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,\n    task_revision INTEGER,\n    title TEXT NOT NULL,\n    description TEXT,\n    acceptance_criteria TEXT,\n    status TEXT DEFAULT 'queued',\n    assigned_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,\n    result_summary TEXT,\n    attempt_count INTEGER NOT NULL DEFAULT 0,\n    created_at TEXT DEFAULT (datetime('now')),\n    started_at TEXT,\n    completed_at TEXT\n)",
    # table: tool_invocation_log
    "CREATE TABLE tool_invocation_log (\n    id INTEGER PRIMARY KEY AUTOINCREMENT,\n    workspace_id TEXT,\n    session_id TEXT,\n    tool TEXT NOT NULL,          -- logical tool name, e.g. 'search_memory'\n    query TEXT,                  -- query/args summary (truncated to 500 chars)\n    result_count INTEGER,        -- results returned, NULL if unknown\n    created_at TEXT DEFAULT (datetime('now'))\n)",
    # table: workflow_runs
    "CREATE TABLE workflow_runs (\n    id TEXT PRIMARY KEY,\n    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,\n    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,\n    kind TEXT DEFAULT 'sweep',\n    label TEXT,\n    source TEXT DEFAULT 'claude_workflow',\n    runtime TEXT,\n    status TEXT DEFAULT 'running',\n    agents_total INTEGER DEFAULT 0,\n    agents_done INTEGER DEFAULT 0,\n    subagents TEXT DEFAULT '[]',\n    params TEXT DEFAULT '{}',\n    result TEXT,\n    error TEXT,\n    started_at TEXT DEFAULT (datetime('now')),\n    completed_at TEXT,\n    created_at TEXT DEFAULT (datetime('now')),\n    updated_at TEXT DEFAULT (datetime('now'))\n)",
    # table: workspace_git_secrets
    "CREATE TABLE workspace_git_secrets (\n    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,\n    secret TEXT NOT NULL,\n    created_at TEXT DEFAULT (datetime('now'))\n)",
    # table: workspace_guidelines
    "CREATE TABLE workspace_guidelines (\n    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,\n    guideline_id TEXT REFERENCES guidelines(id) ON DELETE CASCADE,\n    PRIMARY KEY (workspace_id, guideline_id)\n)",
    # table: workspace_memory
    "CREATE TABLE workspace_memory (\n    id TEXT PRIMARY KEY,\n    workspace_id TEXT NOT NULL,\n    scope TEXT NOT NULL DEFAULT 'project',\n    content TEXT NOT NULL DEFAULT '',\n    provider_hashes TEXT NOT NULL DEFAULT '{}',\n    settings TEXT NOT NULL DEFAULT '{}',\n    last_synced_at TEXT,\n    created_at TEXT NOT NULL DEFAULT (datetime('now')),\n    updated_at TEXT NOT NULL DEFAULT (datetime('now')),\n    UNIQUE(workspace_id, scope)\n)",
    # table: workspaces
    "CREATE TABLE workspaces (\n    id TEXT PRIMARY KEY,\n    name TEXT NOT NULL,\n    path TEXT NOT NULL UNIQUE,\n    color TEXT,\n    human_oversight TEXT DEFAULT 'approve_plans',\n    tester_mode TEXT DEFAULT 'direct',\n    auto_test_enabled INTEGER DEFAULT 1,\n    research_model TEXT,\n    research_llm_url TEXT,\n    review_provider TEXT DEFAULT 'active',\n    preview_url TEXT,\n    default_worktree INTEGER DEFAULT 0,\n    comms_enabled INTEGER DEFAULT 1,\n    coordination_enabled INTEGER DEFAULT 1,\n    context_sharing_enabled INTEGER DEFAULT 1,\n    alloy_enabled INTEGER DEFAULT 0,\n    output_style TEXT,\n    orchestration_policy TEXT DEFAULT '{}',\n    inherit_orchestration_policy_from TEXT REFERENCES workspaces(id) ON DELETE SET NULL,\n    order_index INTEGER DEFAULT 0,\n    created_at TEXT DEFAULT (datetime('now')),\n    last_used_at TEXT,\n    sandbox_type TEXT DEFAULT 'none',\n    sandbox_network INTEGER DEFAULT 1\n, native_terminals_enabled INTEGER DEFAULT 0, auto_register_terminals INTEGER DEFAULT 0, auto_exec_enabled INTEGER DEFAULT 0, commander_max_workers INTEGER DEFAULT 3, tester_max_workers INTEGER DEFAULT 2, commander_max_epics INTEGER DEFAULT 2, auto_approve_blueprint INTEGER DEFAULT 0, advisor_auto_attach INTEGER DEFAULT 0, research_max_iterations INTEGER, pipeline_enabled INTEGER DEFAULT 0, task_dependencies_enabled INTEGER DEFAULT 0, demo_command TEXT DEFAULT 'npm run dev', demo_branch TEXT DEFAULT 'main', demo_port INTEGER DEFAULT 0, board_doc_mode TEXT DEFAULT 'agent_with_backstop', board_doc_new_column TEXT DEFAULT 'review', board_doc_existing_column TEXT DEFAULT 'review')",
    # index: idx_accounts_active_oauth_identity
    "CREATE UNIQUE INDEX idx_accounts_active_oauth_identity ON accounts(cli_type, verified_subject) WHERE type = 'oauth' AND status = 'active' AND verified_subject IS NOT NULL",
    # index: idx_alloy_runs_workspace
    "CREATE INDEX idx_alloy_runs_workspace\n    ON alloy_runs(workspace_id, created_at)",
    # index: idx_alloy_servers_workspace
    "CREATE INDEX idx_alloy_servers_workspace\n    ON alloy_servers(workspace_id, status)",
    # index: idx_audit_actor
    "CREATE INDEX idx_audit_actor\n    ON audit_log(actor_kind, actor_id)",
    # index: idx_audit_ts
    "CREATE INDEX idx_audit_ts\n    ON audit_log(ts)",
    # index: idx_canvas_annotations_canvas
    "CREATE INDEX idx_canvas_annotations_canvas\n    ON canvas_annotations(workspace_id, canvas_id)",
    # index: idx_cascade_runs_session
    "CREATE INDEX idx_cascade_runs_session\n    ON cascade_runs(session_id, status)",
    # index: idx_command_log_session
    "CREATE INDEX idx_command_log_session\n    ON command_log(session_id, created_at)",
    # index: idx_commander_events_created
    "CREATE INDEX idx_commander_events_created\n    ON commander_events(created_at)",
    # index: idx_commander_events_session
    "CREATE INDEX idx_commander_events_session\n    ON commander_events(session_id)",
    # index: idx_commander_events_task
    "CREATE INDEX idx_commander_events_task\n    ON commander_events(task_id)",
    # index: idx_commander_events_type
    "CREATE INDEX idx_commander_events_type\n    ON commander_events(event_type)",
    # index: idx_commander_events_workspace
    "CREATE INDEX idx_commander_events_workspace\n    ON commander_events(workspace_id)",
    # index: idx_commit_attributions_session
    "CREATE INDEX idx_commit_attributions_session\n    ON commit_attributions(workspace_id, session_id, created_at)",
    # index: idx_commit_attributions_sha
    "CREATE INDEX idx_commit_attributions_sha\n    ON commit_attributions(workspace_id, commit_sha)",
    # index: idx_commit_attributions_task
    "CREATE INDEX idx_commit_attributions_task\n    ON commit_attributions(workspace_id, active_ticket_id_snapshot, task_id_snapshot)",
    # index: idx_device_challenges_device
    "CREATE INDEX idx_device_challenges_device\n    ON device_challenges(device_id, consumed_at)",
    # index: idx_devices_active
    "CREATE INDEX idx_devices_active ON devices(revoked_at)",
    # index: idx_devices_fingerprint
    "CREATE INDEX idx_devices_fingerprint ON devices(fingerprint)",
    # index: idx_event_subs_enabled
    "CREATE INDEX idx_event_subs_enabled\n    ON event_subscriptions(enabled)",
    # index: idx_external_access_domain
    "CREATE INDEX idx_external_access_domain\n    ON external_access_log(domain, created_at)",
    # index: idx_external_access_session
    "CREATE INDEX idx_external_access_session\n    ON external_access_log(session_id, created_at)",
    # index: idx_file_activity_lookup
    "CREATE INDEX idx_file_activity_lookup\n    ON file_activity(workspace_id, file_path, created_at)",
    # index: idx_file_activity_session
    "CREATE INDEX idx_file_activity_session\n    ON file_activity(session_id)",
    # index: idx_file_claims_lookup
    "CREATE INDEX idx_file_claims_lookup ON file_claims(workspace_id, path)",
    # index: idx_file_claims_session
    "CREATE INDEX idx_file_claims_session ON file_claims(session_id)",
    # index: idx_invites_active
    "CREATE INDEX idx_invites_active ON invites(redeemed_at, burned_at, expires_at)",
    # index: idx_invites_hash
    "CREATE INDEX idx_invites_hash ON invites(token_hash)",
    # index: idx_invites_workspace
    "CREATE INDEX idx_invites_workspace ON invites(workspace_id, created_at)",
    # index: idx_joiner_sessions_active
    "CREATE INDEX idx_joiner_sessions_active\n    ON joiner_sessions(revoked_at, expires_at)",
    # index: idx_joiner_sessions_hash
    "CREATE INDEX idx_joiner_sessions_hash ON joiner_sessions(token_hash)",
    # index: idx_memory_entries_type
    "CREATE INDEX idx_memory_entries_type\n    ON memory_entries(type)",
    # index: idx_memory_entries_workspace
    "CREATE INDEX idx_memory_entries_workspace\n    ON memory_entries(workspace_id)",
    # index: idx_messages_session
    "CREATE INDEX idx_messages_session\n    ON messages(session_id)",
    # index: idx_observatory_findings_source
    "CREATE INDEX idx_observatory_findings_source\n    ON observatory_findings(source, relevance_score DESC)",
    # index: idx_observatory_findings_status
    "CREATE INDEX idx_observatory_findings_status\n    ON observatory_findings(status)",
    # index: idx_observatory_findings_workspace
    "CREATE INDEX idx_observatory_findings_workspace\n    ON observatory_findings(workspace_id)",
    # index: idx_observatory_insights_lookup
    "CREATE INDEX idx_observatory_insights_lookup ON observatory_insights(scope, workspace_id, insight_type, strength DESC)",
    # index: idx_observatory_profiles_scope
    "CREATE UNIQUE INDEX idx_observatory_profiles_scope ON observatory_profiles(scope, COALESCE(workspace_id, ''))",
    # index: idx_observatory_targets_lookup
    "CREATE INDEX idx_observatory_targets_lookup ON observatory_search_targets(scope, workspace_id, source, status)",
    # index: idx_observatory_targets_scope_value
    "CREATE UNIQUE INDEX idx_observatory_targets_scope_value ON observatory_search_targets(scope, COALESCE(workspace_id, ''), source, target_type, value)",
    # index: idx_package_scans_package
    "CREATE INDEX idx_package_scans_package\n    ON package_scans(package, ecosystem)",
    # index: idx_package_scans_session
    "CREATE INDEX idx_package_scans_session\n    ON package_scans(session_id, created_at)",
    # index: idx_peer_messages_in_reply_to
    "CREATE INDEX idx_peer_messages_in_reply_to ON peer_messages(in_reply_to)",
    # index: idx_peer_messages_workspace
    "CREATE INDEX idx_peer_messages_workspace\n    ON peer_messages(workspace_id, created_at)",
    # index: idx_pipeline_definitions_preset
    "CREATE INDEX idx_pipeline_definitions_preset\n    ON pipeline_definitions(preset_key)",
    # index: idx_pipeline_definitions_workspace
    "CREATE INDEX idx_pipeline_definitions_workspace\n    ON pipeline_definitions(workspace_id)",
    # index: idx_pipeline_runs_pipeline
    "CREATE INDEX idx_pipeline_runs_pipeline\n    ON pipeline_runs(pipeline_id, status)",
    # index: idx_pipeline_runs_task
    "CREATE INDEX idx_pipeline_runs_task\n    ON pipeline_runs(task_id)",
    # index: idx_pipeline_runs_workspace
    "CREATE INDEX idx_pipeline_runs_workspace\n    ON pipeline_runs(workspace_id, status)",
    # index: idx_port_leases_port
    "CREATE INDEX idx_port_leases_port\n    ON port_leases(port, status)",
    # index: idx_port_leases_session
    "CREATE INDEX idx_port_leases_session\n    ON port_leases(session_id, status)",
    # index: idx_port_leases_workspace
    "CREATE INDEX idx_port_leases_workspace\n    ON port_leases(workspace_id, status)",
    # index: idx_push_subs_actor
    "CREATE INDEX idx_push_subs_actor\n    ON push_subscriptions(actor_kind, actor_id)",
    # index: idx_research_entries_scope
    "CREATE INDEX idx_research_entries_scope ON research_entries(scope, workspace_id, updated_at DESC)",
    # index: idx_research_schedules_scope
    "CREATE INDEX idx_research_schedules_scope ON research_schedules(scope, workspace_id, created_at DESC)",
    # index: idx_safety_approval_grants_lookup
    "CREATE INDEX idx_safety_approval_grants_lookup\n    ON safety_approval_grants(\n        actor_kind, actor_id, workspace_id, session_id, rule_id,\n        operation_digest, approval_expires_at, operation_consumed_at\n    )",
    # index: idx_safety_decisions_pattern
    "CREATE INDEX idx_safety_decisions_pattern\n    ON safety_decisions(tool_name, decision)",
    # index: idx_safety_decisions_session
    "CREATE INDEX idx_safety_decisions_session\n    ON safety_decisions(session_id, created_at)",
    # index: idx_safety_decisions_tool_use
    "CREATE INDEX idx_safety_decisions_tool_use\n    ON safety_decisions(tool_use_id)",
    # index: idx_safety_rules_enabled
    "CREATE INDEX idx_safety_rules_enabled\n    ON safety_rules(enabled, workspace_id)",
    # index: idx_script_approvals_hash
    "CREATE INDEX idx_script_approvals_hash\n    ON script_approvals(script_hash)",
    # index: idx_script_approvals_workspace
    "CREATE INDEX idx_script_approvals_workspace\n    ON script_approvals(workspace_id, approved_at)",
    # index: idx_secure_decisions_run
    "CREATE INDEX idx_secure_decisions_run ON secure_decisions(run_id)",
    # index: idx_secure_findings_run
    "CREATE INDEX idx_secure_findings_run ON secure_findings(run_id)",
    # index: idx_secure_runs_session
    "CREATE INDEX idx_secure_runs_session ON secure_runs(session_id)",
    # index: idx_secure_runs_status
    "CREATE INDEX idx_secure_runs_status ON secure_runs(status)",
    # index: idx_session_digests_workspace
    "CREATE INDEX idx_session_digests_workspace\n    ON session_digests(workspace_id)",
    # index: idx_session_guidelines_session
    "CREATE INDEX idx_session_guidelines_session\n    ON session_guidelines(session_id)",
    # index: idx_session_mcp_servers_session
    "CREATE INDEX idx_session_mcp_servers_session\n    ON session_mcp_servers(session_id)",
    # index: idx_session_turn_summaries_session
    "CREATE INDEX idx_session_turn_summaries_session\n    ON session_turn_summaries(session_id, created_at)",
    # index: idx_sessions_status
    "CREATE INDEX idx_sessions_status\n    ON sessions(status)",
    # index: idx_sessions_workspace
    "CREATE INDEX idx_sessions_workspace\n    ON sessions(workspace_id)",
    # index: idx_task_dispatch_intents_task
    "CREATE INDEX idx_task_dispatch_intents_task\n    ON task_dispatch_intents(task_id, status)",
    # index: idx_task_dispatch_intents_workspace
    "CREATE INDEX idx_task_dispatch_intents_workspace\n    ON task_dispatch_intents(workspace_id, status)",
    # index: idx_tasks_queued_for
    "CREATE INDEX idx_tasks_queued_for ON tasks(queued_for_session_id, queue_order)",
    # index: idx_tasks_workspace_status
    "CREATE INDEX idx_tasks_workspace_status\n    ON tasks(workspace_id, status)",
    # index: idx_test_queue_task_revision
    "CREATE UNIQUE INDEX idx_test_queue_task_revision ON test_queue(workspace_id, task_id, task_revision) WHERE task_id IS NOT NULL AND task_revision IS NOT NULL",
    # index: idx_tool_invocation_log_session
    "CREATE INDEX idx_tool_invocation_log_session\n    ON tool_invocation_log(session_id, created_at)",
    # index: idx_tool_invocation_log_tool
    "CREATE INDEX idx_tool_invocation_log_tool\n    ON tool_invocation_log(tool, created_at)",
    # index: idx_workflow_runs_session
    "CREATE INDEX idx_workflow_runs_session\n    ON workflow_runs(session_id)",
    # index: idx_workflow_runs_workspace
    "CREATE INDEX idx_workflow_runs_workspace\n    ON workflow_runs(workspace_id, status)",
    # trigger: workspaces_w2w_defaults_on_insert
    "CREATE TRIGGER workspaces_w2w_defaults_on_insert\n                   AFTER INSERT ON workspaces\n                   WHEN COALESCE(NEW.comms_enabled, 0) = 0\n                     OR COALESCE(NEW.coordination_enabled, 0) = 0\n                     OR COALESCE(NEW.context_sharing_enabled, 0) = 0\n                   BEGIN\n                       UPDATE workspaces\n                          SET comms_enabled = 1,\n                              coordination_enabled = 1,\n                              context_sharing_enabled = 1\n                        WHERE id = NEW.id;\n                   END",
)
