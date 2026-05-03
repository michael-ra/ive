# IVE Code Description & Function Catalog

Format: `name(args): purpose | →deps  ←callers/triggers  ◆effect`
- `→` outbound call/dep · `←` inbound trigger · `◆` side effect · `↔` shared state via DB/bus
- Privates (`_foo`) shown only when load-bearing.

---

## 0 · Tech stack & wiring at a glance

```
backend/  Python 3.11 · aiohttp · aiosqlite · asyncio · MCP stdio · Playwright
frontend/ React 18 · Vite · Zustand · xterm.js · Tailwind · Mermaid
ipc       JSON over WebSocket (/ws) · stdio JSON-RPC for MCP · /api/* REST
db        ~/.ive/ive.db (SQLite) — schema in db.init_db()
events    backend/event_bus.py — pub/sub of CommanderEvent across all subsystems
```

---

## 1 · backend/server.py — aiohttp app & route handlers (~17.7K LOC)

Module: orchestrates HTTP/WS, owns the app object, wires every other backend module via `create_app()`.

### Lifecycle / app
- `create_app() → web.Application`: registers ALL routes + middlewares + on_startup/cleanup ◆entrypoint.
- `on_startup(app)`: opens DB, starts schedulers (research/supervisor/auto_learn/telemetry), kicks plugin sync.
- `on_cleanup(app)`: shuts down PTYs, demos, preview browser, tunnel.
- `main()`: bind host/port, generate auth token, print banner, optionally start mDNS + cloudflared tunnel.
- `_start_cloudflare_tunnel(port)`: spawn cloudflared, parse public URL ◆updates runtime tunnel state.

### WebSocket fan-out
- `ws_handler(request)`: subscribes a client; routes `pty_input`, `subscribe_session`, `unsubscribe`, preview frame events.
- `broadcast(event)`: send JSON to all subscribed websockets ←every subsystem (`event_bus`, `pipeline`, `cascade_runner`, `demo_runner`, `preview_browser`, `idle_reflection`).
- `_ws_subscriber_id(ws)`: stable id for browser subscriber.

### PTY plumbing
- `handle_pty_output(session_id, data)`: ANSI-tail-split → output_capture → schedule flush.
- `_flush_output(session_id)`: emits buffered terminal bytes to subscribers, persists transcript.
- `handle_pty_exit(session_id, code)`: → `_maybe_auto_distill`, `_maybe_auto_extract_knowledge`, `_maybe_auto_summarize`, `_maybe_handle_gemini_branch`.
- `_check_auto_trust(session_id, data)`: detects "trust this folder?" prompt, autoreplies.
- `_track_input(session_id, raw)`: buffers user turns ↔`get_session_turns`.
- `_maybe_expand_input(session_id, raw)`: expands `@prompt-name`, `/cascade`, `@ralph` tokens before send.
- `_maybe_unarchive_on_input(session_id)`: unhide archived sessions when user types.
- `_maybe_handle_gemini_branch(session_id)`: detects `gemini /chat branch` and forks a tab.

### Sessions
- `list_sessions / create_session / delete_session / update_session / rename_session`: REST CRUD.
- `_autostart_session_pty(session_id)`: spawn the actual CLI PTY (claude/gemini) per session row.
- `clone_session / merge_sessions / distill_session / summarize_session / search_messages`: history ops.
- `switch_session_cli / switch_model`: hot-switch claude↔gemini and model id.
- `pop_out_session`: spawn external terminal, hand off PTY.
- `assign_task_to_session / queue_task_for_session / get_session_queue`: per-session worker queue.
- `_build_worker_handoff_prompt(task)`: produce assignment prompt for worker MCP.
- `create_commander / create_tester / create_documentor / create_observatorist`: spawn pre-configured role sessions with their MCP server attached.

### Workspaces
- `list_workspaces / create_workspace / update_workspace / delete_workspace / reorder_workspaces`.
- `browse_folder`: filesystem picker for workspace root.
- `get_workspace_overview`: aggregates git, sessions, demos, memory, observatory for left-pane.
- `get_workspace_git_{status,diff,log}` → `git_ops.py`.
- `open_in_ide`: launch VSCode/Cursor at workspace path.

### Memory / knowledge / W2W (REST surface)
- `get_workspace_memory / update / sync / diff / resolve / settings`: 3-way merge with CLI files via `memory_sync`.
- `import_memory_from_cli / export_memory_prompt / compact_memory_entries`.
- `list_memory_entries / create / update / delete / search`: typed memory CRUD.
- `autofill_vision`: LLM-proposes workspace vision from project files.
- `unified_memory_search`: search memory_entries + workspace_knowledge + digests in one shot.
- `export_knowledge_to_config`: write knowledge → CLAUDE.md/GEMINI.md.
- `list_peer_messages / create_peer_message / mark_peer_message_read`: W2W bulletin board.
- `get_session_digest / update_session_digest`: per-session running digest.
- `list_workspace_knowledge / create / update / delete / get_knowledge_prompt`.
- `get_file_activity / list_recent_file_activity`: who-touched-what tracking.
- `find_similar_tasks / find_similar_sessions`: cosine search via `embedder`.
- `check_coordination_overlap`: pre-edit overlap check (myelin if available, else fallback).

### Pipelines / cascades / RALPH / tasks
- `list_pipeline_definitions/runs`, `start_pipeline_run`, `start_ralph_pipeline` → `pipeline_engine`.
- `list_cascades / create / update / use_cascade / list_cascade_runs / create_cascade_run` → `cascade_runner`.
- `list_tasks / create_task / update_task / iterate_task / delete_task / list_task_events`.
- `handle_pipeline_result`: webhook called by tester/documentor MCP → drives `pipeline._on_test_completed`.

### Safety / AVCP
- `evaluate_safety`: per-tool-call gate, returns allow/deny/ask + memory of approvals.
- `_avcp_scan_inline(command, session, ws)`: scan packages for malicious install scripts inline before allow.
- `list_safety_rules/decisions/proposals`, `accept/dismiss_safety_proposal`, `report_safety_approved`.
- `seed_safety_rules` → `safety_engine.seed_builtin_rules`.
- `get_install_script_policy / put / add/remove_install_script_allowlist`.
- `get_external_access_log / get_command_log / get_package_scans`.

### Observatory
- `list_observatory_findings / get/regenerate/recalibrate/update_observatory_profile`.
- `list/add/update/delete/plan_observatory_search_targets`, `triage_observatory_items`.
- `trigger_observatory_smart_scan / trigger_observatory_scan / list_observatory_scans`.
- `list/upsert/update/delete_observatory_insight`.
- `get/set_observatory_api_keys`, `test_observatory_api_key`.
- `promote_observatory_finding`: finding → task.

### Auth / multi-actor / devices / invites / push
- `auth_login / logout_handler / whoami_handler`: token cookie auth.
- `token_auth_middleware`: gate every `/api/*` request via `auth_context.resolve_auth`.
- `_resolve_caller(request)`: identifies actor (owner / joiner / device).
- `_is_rate_limited / _record_auth_failure`: brute-force backoff.
- `create_invite_handler / list / revoke / redeem`: speakable+QR invites.
- `device_pair_init / device_challenge / device_pair_complete`: ed25519 device pairing.
- `list_devices_handler / revoke_device_handler`.
- `runtime_status / runtime_tunnel_start/stop / runtime_mode / runtime_multiplayer_toggle`.
- `push_subscribe / unsubscribe / vapid_pubkey`: web-push registration.
- `list_audit_log_handler`: audit trail.

### Catch-up & docs build
- `catchup_handler`: time-window digest of events+commits+memory, optional LLM summary, ◆gates by `?cli=` or model-prefix.
- `get_docs_status / trigger_docs_build`: VitePress build per workspace.
- `get_agents_md / save_agents_md`: shared CLAUDE.md/GEMINI.md edit surface.

### Misc REST
- `list_research / create / update / search / get_research_with_sources`: research DB.
- `start_research / decompose_research_plan / steer / resume / stop_research_job`: research engine.
- `list/create/update/delete_research_schedule` + `_research_scheduler_loop`: cron driver.
- `list_plan_files / get / put_plan_file`: plan markdown CRUD inside workspace.
- `take_screenshot / get_workspace_preview_screenshot / install_screenshot_tools / paste_image / serve_paste / upload_attachment`.
- `preview_proxy / proxy_localhost`: stream user dev server to web UI.
- `list_app_settings / get / put_app_setting`.
- `list_experimental_features`.
- `list_output_styles / list_cli_info / get_cli_feature_matrix`.
- `list_accounts / create / update / delete / test_account / open_account_browser / open_next_account / snapshot_account / restart_with_account / playwright_*`: multi-account auth carousel.
- `list/create/update/delete_grid_template`, `list/create/update/delete_tab_group`, `list/create/delete_template`, `apply_template`.
- `list/create/update/delete_prompt`, `use_prompt`, `reorder_quickactions`.
- `list/create/update/delete_guideline`, `get/set_session_guidelines`, `recommend_session_guidelines`, `dismiss_guideline_recommendation`, `analyze_session_endpoint`, `get_guideline_effectiveness`.
- `list/create/update/delete_mcp_server`, `parse_mcp_docs`, `get/set_session_mcp_servers`.
- `list/install/uninstall/sync/search_agent_skills`, `get_agent_skill_content`, `dismiss_skill_suggestion`.
- `list/add/update/delete_plugin_registry`, `sync_plugin_registry`, `sync_all`, `list/get/install/uninstall_plugins`, `get/set_session_plugin_components`.
- `list_test_queue / enqueue_test / remove_from_test_queue / update_test_queue_entry`, `_process_test_queue`.
- `list_broadcast_groups / create / update / delete`: send-to-many groups.
- `list_events / get_event_catalog / emit_event_handler`, `list/create/update/delete_event_subscription`.
- `list/get_demo / start / stop / pull_latest_demo / list_demos / get_demo_log` → `demo_runner`.
- `list/approve/reject_autolearn` → `auto_learn`.
- `get/list_session_health / restart_session` → `session_supervisor`.
- `list_api_keys / save_api_key / test_api_key` → `api_keys`.
- `handle_hook_discover`: hooks-on-demand registration; tied to `hook_installer` discovery.

### Auto-pipelines (post-exit)
- `_maybe_auto_distill(session_id, exit_code)`: classify conversation → spawn distill chain.
- `_detect_distill_type(text)`: heuristic for distill flavor.
- `_maybe_auto_extract_knowledge(session_id, exit)`: LLM extracts patterns/conventions/gotchas → `workspace_knowledge`.
- `_maybe_auto_summarize(session_id)`: produces one-liner session summary, ↔embedder.

---

## 2 · backend/db.py — schema + helpers

Module: aiosqlite singleton + schema migrations (`init_db`).
- `get_db()`: returns shared connection ◆auto-runs `init_db` on first call.
- `init_db()`: creates ~50 tables (sessions, tasks, peer_messages, workspace_knowledge, memory_entries, pipeline_*, cascade_*, observatory_*, safety_*, plugin_*, audit_log, …) and runs additive migrations.
- `_load_deep_research_guideline()`: bundled prompt for research session bootstrap.

---

## 3 · backend/config.py

Constants: `DATA_DIR=~/.ive`, DB path, hook path, ports. Read by every module — do not mutate.

---

## 4 · backend/event_bus.py — pub/sub spine

- `emit(event, payload, **kwargs) → EventRecord`: insert into `events` table, fan out to in-process subscribers, optional remote bridges. ←hooks, pipeline, cascade_runner, auto_exec, worker_queue, idle_reflection, demo_runner, observatory.
- Subscribers register via `register_subscribers()` in each module; events drive cross-module behaviour.

---

## 5 · backend/hooks.py — CLI hook receiver

Module: receives PreToolUse/PostToolUse/Stop/Notification/SessionEnd/SubagentStart/SubagentStop/Compaction events POSTed by `~/.ive/hooks/hook.sh`.

- `handle_hook_event(request)`: top-level dispatcher → routes by event_name to `_handle_*`.
- `_handle_pre_tool_use(session, payload)`: safety gate, AVCP scan, w2w-conflict warning, push approval if needed.
- `_handle_post_tool_use(session, payload)`: log external_access / commands, scan packages, fire file-activity, emit event.
- `_handle_stop(session, payload)`: triggers idle_reflection scheduling, doom-loop guard, auto-title, auto-distill cascade.
- `_handle_notification(session, payload)`: extract action options, push notify owner.
- `_handle_subagent`: track subagent lifecycle for `SubagentTree`.
- `_handle_session_end / _handle_compaction / _handle_file_changed`.
- `_handle_worktree_create / _handle_worktree_remove`: branch label allocation.
- `_dispatch_plugin_hooks(session, event, payload)`: fan event to installed plugin hook scripts.
- `_w2w_check_file_conflict / _w2w_track_file_touched / _w2w_record_file_activity / _w2w_check_peer_warnings`: peer file-overlap mitigation; `_queue_pty_warning` injects warnings into terminal stream.
- `_log_external_access / _log_command / _scan_packages`: AVCP/audit trail.
- `_detect_ecosystem(cmd) / _extract_packages / _detect_install_scripts`: package discovery.
- `_maybe_capture_native_id(commander_id, payload)`: bind backend session_id ↔ CLI session id.
- `_get_state(session_id)`: per-session in-memory hook state (counters, dedupe).
- `_maybe_auto_title(session_id) / _generate_title(session, cli, ctx)`: LLM-name unnamed sessions.
- `_get_w2w_enabled(session_id, flag)`: gate W2W behaviour by workspace flags.
- `_nudge_commander_for_idle_worker(worker_id)`: when worker stalls, ping commander.
- `_push_notify(tag, title, body, url)`: forward to web-push.

---

## 6 · backend/hook_installer.py — install/uninstall hook scripts

- `generate_hook_script() / generate_safety_gate_script()`: emit `~/.ive/hooks/hook.sh` and `safety_gate.sh` with CLI-aware JSON.
- `install_claude_hooks / install_gemini_hooks / install_avcp_hooks / install_myelin_hooks / install_safety_gate_hooks`: write `settings.json` entries idempotently.
- Mirror `uninstall_*` for each.
- `install_all / uninstall_all / check_installation`: aggregate status.
- `_settings_path_for(profile)`: ~/.claude/settings.json or ~/.gemini/settings.json.
- `_merge_hooks(settings, events)`: append IVE hook entry without clobbering user hooks.
- `check_avcp_installation / check_myelin_installation / check_safety_gate_installation`: diagnostic for UI panels.

Note: spawned sessions need `COMMANDER_CLI_TYPE` env var so `hook.sh` emits the right protocol.

---

## 7 · MCP servers

### 7a · backend/mcp_server.py — Commander MCP

stdio JSON-RPC tool surface attached to Commander sessions. All tools call `api_call(method, path, body)` → backend REST.

- `tool_list_sessions / create_session / send_message / read_session_output / get_session_status / stop_session`.
- `tool_escalate_worker(args)`: bump priority / hand worker to commander.
- `tool_deep_research / list_research_jobs / get_research / search_research / save_research`.
- `tool_list_tasks / get_task / create_task / update_task`.
- `tool_broadcast_message / get_output_captures`.
- `tool_set_preview_url / get_preview_url / screenshot_preview` → `preview_browser`.
- `tool_checkpoint`: dual-model checkpoint protocol (proceed/modify/abort).
- `tool_switch_model`: in-conversation model swap.
- `tool_search_memory / save_memory / recall_memory / contribute_knowledge`.
- `tool_headsup`: non-blocking peer ping.
- `tool_list_worker_digests / get_session_digest / check_coordination`.
- `tool_coord_check_overlap / coord_acquire / coord_release / coord_peers` → `peer_comms` (myelin).
- `tool_tag_session`.
- `tool_queue_task_for_worker / assign_task_to_worker`.
- `tool_request_docs_update`: ping documentor.
- `tool_search_skills / get_skill_content` → `skill_suggester`/`skills_client`.
- `handle_jsonrpc(request)`: top-level JSON-RPC dispatch ◆stdout response.
- `main()`: stdio loop entry.

### 7b · backend/worker_mcp_server.py — Worker/Planner MCP (trimmed surface)

- `tool_get_my_tasks / get_my_task / update_my_task`: per-session task drawer.
- `tool_post_message / check_messages / list_peers / update_digest`: bulletin board + digest.
- `tool_contribute_knowledge`: append workspace_knowledge entry (categories: architecture/convention/gotcha/pattern/api/setup).
- `tool_find_similar_sessions / find_similar_tasks`: cosine search.
- `tool_get_file_context(file_path)`: who-else-recently-edited.
- `tool_search_memory / query_knowledge / search_skills / get_skill_content`.
- `tool_report_pipeline_result`: hand result back to pipeline driver (handle_pipeline_result).
- `tool_save_memory / recall_memory`: typed memory entries.
- `tool_headsup / blocking_bulletin`: coord pings; `blocking_bulletin` blocks worker until reply or timeout.
- `tool_coord_check_overlap / acquire / release / peers`: myelin overlap detection.
- `tool_create_task`: workers can spawn subtasks (capability gated).
- `_load_workspace_flags()`: enables/disables tools at registration time per workspace ◆silently returns `{}` on API failure → tools missing but prompt still references them.
- `_app_setting(key)`: pull global flag.
- `_is_my_task(task_id)`: scope guard.
- `handle_request / main`: stdio loop.

### 7c · backend/documentor_mcp_server.py — Documentor MCP

- `tool_get_knowledge_base`: full ws_knowledge dump.
- `tool_get_changes_since(since)`: commits + memory diffs since timestamp.
- `tool_get_completed_features`: tasks finished since last doc build.
- `tool_screenshot_page / screenshot_element / screenshot_panel`: Playwright capture for docs.
- `tool_record_gif`: MP4/gif recording.
- `tool_scaffold_docs`: bootstrap VitePress site under workspace `docs/`.
- `tool_write_doc_page / get_doc_tree / get_docs_manifest / update_docs_manifest`: VitePress IO.
- `tool_build_site / preview_site`: build & local-preview.
- `tool_save_memory`: typed memory entries.
- `_load_manifest / _save_manifest / _write_file`: VitePress manifest helpers.
- `handle_jsonrpc / main`: stdio loop.

---

## 8 · backend/idle_reflection.py — auto-reflection prompt

- `set_pty_manager / set_broadcast_fn`: dependency wiring at startup.
- `register_subscribers()`: subscribe to Stop event.
- `_fire(session_id, cli_type, workspace_id)`: send role-typed reflection prompt to PTY ◆conditional on `_is_enabled`, tool-use count ≥12, throttle 1800s.
- `_build_prompt(session_type)`: returns universal+role-specific bullets (`_UNIVERSAL_BULLETS`, `_WORKER_BULLETS`, `_TESTER_BULLETS`).
- `cancel(session_id) / clear_session(session_id)`: prevent spurious fires.

---

## 9 · backend/embedder.py — vector search

- `_get_model() / _get_reranker()`: lazy-load sentence-transformers + cross-encoder.
- `embed(text) / embed_batch(texts)`: returns vector(s) or None when model unavailable.
- `rerank(query, docs)`: cross-encoder relevance scoring.
- `task_dense_text / digest_dense_text / knowledge_dense_text / guideline_dense_text`: canonical dense rep per entity type.
- `embed_task / embed_digest / embed_knowledge / embed_guideline`: embed + persist.
- `remove_guideline_embedding`.
- `_cosine(a, b)`: similarity.

---

## 10 · backend/peer_comms.py — myelin coordination wrapper

- `myelin_check_overlap(agent, intent, file)`: cosine-search across active workers' digests/intents.
- `myelin_acquire(agent, file, intent) / myelin_release(agent, file)`: file lock proxy.
- `myelin_peers(agent)`: return active peers + their stated intents.
- `_ensure_myelin_path / _try_import_myelin / _build_workspace`: optional dependency loading.
- `_coord_threshold()`: app_setting `coord_threshold` (default 0.80).

---

## 11 · backend/safety_engine.py — rule engine + AVCP

- `seed_builtin_rules(db)`: seed deny/ask/allow rules.
- `_normalize_command(cmd)`: tokenise shell command for matching.
- `_tool_matches / _extract_match_field / _is_command_tool`: rule matching.
- `_rule(name,...)`: factory.
- `init_cache(loader) / invalidate_cache`: cache rule list.
- `remember_approval(rule_id, input_summary) / is_approved / clear_approvals`: per-session approval cache.

## 11a · backend/safety_learning.py — propose new rules from user responses
- `record_user_response(db, tool_use_id, response)`: track allow/deny clicks → propose generalised rule.
- `_normalize_command / _normalize_path`: cluster similar inputs.
- `dismiss_proposal(proposal_id)`: clear suggestion.

## 11b · backend/mode_policy.py — runtime mode gating
- `filter_task_update_body(body, mode)`: drop fields disallowed by current mode.
- `validate_brief_status_transition(new_status)`: brief-mode workflow guard.

## 11c · backend/route_guards.py — middleware deco
- `requires_mode(*allowed)`: guard route by runtime mode.
- `block_for_brief(handler) / owner_only(handler)`: convenience guards.
- `_emit_violation(request, ctx, allowed)`: audit emit.

---

## 12 · Pipelines / cascades / auto-exec / worker queue

### 12a · backend/pipeline_engine.py — generic stage graph
- `create_definition / update / delete / get / list_definitions`: pipeline CRUD.
- `_build_task_variables(task_id)`: substitution map for stage prompts.
- `_execute_stage(run_id, stage_id)`: spawn session, send prompt, watch result.
- `_complete_stage / _fail_stage / _maybe_complete / _complete_run`: state transitions ↔events.
- `_evaluate_condition(stage, output)`: branch decision from structured tag in output.
- `_parse_structured_result(output)`: parse `<<RESULT type=...>>` block.
- `_increment_iteration / _set_current_stages / _update_stage_session`.
- `pause_run / resume_run / cancel_run / get_run / delete_run / list_runs`.
- `on_session_idle(session_id)`: drive next stage when worker finishes.
- `start_ralph(session_id, prompt, ws_id)`: convenience entrypoint for execute→verify→fix preset.
- `ensure_presets()`: seed `ralph-pipeline` etc.
- `check_triggers(event_name, payload)`: auto-start runs from event_subscriptions.
- `is_task_in_pipeline(task_id)`: filter UI affordances.
- `register_subscribers / _on_event / recover_active_runs`.

### 12b · backend/pipeline.py — fixed Tester→Documentor→Worker loop
- `_maybe_route_to_testing / _route_to_testing / _route_to_documentor / _route_back_to_implementor`: deterministic transitions.
- `_ensure_tester_session / _ensure_documentor_session`: lazy-spawn role sessions.
- `_build_doc_prompt(task, test_results)`.
- `_on_task_status_changed / _on_test_completed`: event handlers.
- `_complete_pipeline / _maybe_complete_pipeline / _clear_pipeline_stage_if_needed`.

### 12c · backend/cascade_runner.py — linear step runner with pause-for-vars
- `_advance(run_id) / _send_step(session_id, run_id, steps, idx)`: send next message.
- `pause_run / resume_run / stop_run / resume_with_variables`.
- `_substitute_variables(template, values)`: `{{var}}` replacement.
- `on_session_idle(session_id)`: drive next step when current finishes.
- `list_runs / get_run / _get_active_run / _broadcast_progress`.
- `recover_active_runs()`: resume after restart.

### 12d · backend/auto_exec.py — auto-dispatch tasks to workers
- `_maybe_dispatch(workspace_id, task_id?)`: pick a free worker session, hand it the task.
- `_deps_unmet(task)`: check task dependencies.
- `_build_task_prompt(task)`: render assignment.
- `_on_task_created / _on_task_completed / _on_iteration_requested`: subscribers.
- `_do_dispatch`: actually spawn / queue.

### 12e · backend/worker_queue.py — per-session task queue
- `on_session_idle(session_id)`: deliver next queued task.
- `_maybe_deliver / _do_deliver`: serialise per session_id lock.
- `_build_handoff_prompt(task)`: format prompt with task body + context.
- `_on_task_completed`: clear queue marker.

---

## 13 · Observatory

### 13a · backend/observatory.py — broad scans
- `scan_github / scan_hackernews / scan_producthunt`: source scrapers.
- `_scan_ph_api / _scan_ph_search / _fetch_hn_item / _parse_ddg_html`.
- `_get_workspace_context(ws_id)`: assemble context blob for analyzer.
- `analyze_finding(item, mode, context)`: LLM relevance + insight extraction.
- `get_finding / update_finding / delete_finding / promote_to_task / get_scans`.
- `get_source_settings / update_source_settings`: per-source per-workspace flags.

### 13b · backend/observatory_smart.py — target-driven smart scans + voice extract
- `scan_reddit_subreddit / fetch_reddit_top_comments`.
- `scrape_for_target(target)`: dispatch by target.target_type to `_scrape_{github,reddit,hackernews,producthunt}_target`.
- `_scrape_hn_front_page / _scrape_ph_front_page / _extract_page_text`.
- `voice_extract(ws, item)`: LLM extracts pain/competitor/wish/quote insights from comments.
- `list_insights(ws, type)`: filter `workspace_insights`.
- `_voice_prompt / _merge_prompt`: prompt builders.

### 13c · backend/observatory_profile.py — profile + planner + recalibration
- `build_profile(workspace_id) → profile_dict`: LLM-generated workspace personality from inputs.
- `_collect_inputs / _read_*`: aggregate vision, memory, digests, user turns, promote/dismiss history.
- `get_profile / render_profile_prose`.
- `plan_targets(workspace, source)`: LLM proposes search targets per source.
- `triage_items(workspace, items)`: filter/score scrape results.
- `recalibrate_profile(workspace)`: re-derive profile from user feedback.
- `update_target / delete_target / record_target_scan`.

---

## 14 · backend/memory_manager.py — typed memory CRUD

- `_row_to_dict(row)`: shape DB row.
- (Most logic exposed via REST handlers in server.py; this module owns the SQL.)

## 14a · backend/memory_sync.py — 3-way merge with CLI files

- `_parse_frontmatter(text)`: parse `---` block.
- `get_provider(cli) / all_providers / _ensure_providers`: registry of CLAUDE.md / GEMINI.md providers.
- `is_memory_path(file_path)`: is this a memory file the user edited?
- `_sha256(content)`: dedupe hash.
- `git_diff(old, new)`: patience diff for resolve UI.
- `parse_conflict_markers(content)`: detect unresolved `<<<<<<<` blocks.

---

## 15 · backend/session_supervisor.py — health probe + auto-restart

- `_probe_loop()`: every N seconds → `_probe_once` → per-session `_probe_session`.
- `_probe_session(id, now, auto_restart)`: ping PTY, detect dead/zombie ◆auto-restart-with-backoff if enabled.
- `_auto_restart_with_backoff(session_id)`: exponential backoff respawn.
- `_spawn_pty_from_row(row)`: rebuild PTY from session row.
- `_wait_for_pty_death(session_id, timeout)`.
- `get_health(session_id) / list_health`: REST output.
- `start(app) / stop(app)`: lifecycle.

---

## 16 · backend/cli_session.py — CLI process spawn

(Heavy; main entrypoints used by `_autostart_session_pty`)
- `build_feature_matrix() → dict`: enumerate per-CLI capabilities for UI gating.
- (Defines per-CLI argv builders; respects model id, permission mode, MCP attachments, env propagation including `COMMANDER_CLI_TYPE`.)

## 16a · backend/cli_profiles.py — CLI capability profiles
- `get_profile(cli_id) / all_profiles`: returns CLIProfile (models, permission modes, hook keys, settings paths).
- `_parse_list / _is_truthy_worktree`: profile loader helpers.

## 16b · backend/cli_features.py — runtime feature flags shaped per-CLI.
## 16c · backend/output_capture.py
- `strip_ansi(text)`: ANSI scrubber.
- `_is_quota_error(clean)`: detect rate-limit / quota messages for UI banner.

---

## 17 · backend/llm_router.py — model dispatch

- `llm_call(cli, model, prompt, ...)`: route to `claude` or `gemini` CLI subprocess (or HTTP if standalone) ◆respects `catchup_model`/`research_model` global settings.

## 17a · backend/model_discovery.py
- `discover_claude_models() / discover_gemini_models() / discover_all`: probe local CLIs for available models, surface to settings UI.
- `_version_key / _gemini_model_desc`: ordering / labeling.

## 17b · backend/api_keys.py
- `_register(*defs)`: register known providers.
- `resolve(name) / get_all_status / save / delete / resolve_env_overrides`: keyring + DB-backed key store ◆read by `llm_router`, `observatory`, `embedder`.

---

## 18 · backend/auth_context.py — caller identity
- `resolve_auth(request, *, auth_token, tunnel_mode) → AuthContext|None`: validates owner token / joiner cookie / device sig.
- `_is_real_localhost(request, tunnel_mode)`: gate localhost shortcuts when tunnelled.
- `_tokens_equal(a, b)`: constant-time compare.

## 18a · backend/devices.py — pairing
- `issue_challenge(device_id) → (nonce, expires_at)`: ed25519 challenge.
- `fingerprint_for(public_key)`: human-readable hash.
- `list_devices / revoke_device / cleanup_expired_challenges`.

## 18b · backend/joiner_sessions.py — multi-actor sessions
- `new_cookie_value`: generate join cookie.
- `list_active / revoke / revoke_by_invite`.
- `_hash_cookie / _row_to_session`.

## 18c · backend/invites.py — speakable + QR codes
- `encode_speakable(n) / decode_speakable(s)`: word-list 4-tuple.
- `encode_compact / decode_compact / encode_qr_secret / decode_qr_secret / decode_any`.
- `hash_secret(n)`: store-side hash.
- `list_invites / revoke_invite / redeem_invite / _bump_attempts`.

## 18d · backend/push.py — web-push (VAPID)
- `_generate_vapid_keypair / _load_vapid / get_public_key`: VAPID lifecycle.
- `list_for_actor / list_owner_subscriptions`: subscription drawer.

---

## 19 · Plugin & skill subsystem

### 19a · backend/registry_client.py
- `fetch_registry_index(url) / fetch_plugin_package(url) / normalize_plugin_entry`.

### 19b · backend/plugin_manager.py
- `list_registries / add_registry / delete_registry / sync_registry`.
- `_record_sync_error`.
- `get_plugin / install_plugin / uninstall_plugin`.
- `get_session_components / set_session_components`: per-session component activation.

### 19c · backend/plugin_translator.py
- `fetch_translation_docs(src_cli, target_cli)`: pull docs for translation context.
- `_fetch_doc / _fetch_cli_help`.
- `build_translation_context(src, target, live_docs)`: assembled prompt.

### 19d · backend/plugin_exporter.py
- `classify_hook(trigger) / classify_plugin_hooks(components)`: bucket Pre/Post/Stop etc.
- `_build_claude_manifest / _build_gemini_manifest`: per-CLI manifest.
- `translate_hooks(hooks, src, target) / translate_mcp_vars / translate_mcp_config`: cross-CLI hook translation.

### 19e · backend/plugin_importer.py
- `_parse_skill_frontmatter(text)`: ingest skill from disk.

### 19f · backend/skill_installer.py
- `_skill_base(cli, ws_path, scope) / _slugify(name)`: target dir.
- `_parse_frontmatter_meta / _download_skill_extras`.

### 19g · backend/skill_suggester.py
- `ensure_index(force)`: build skill embedding index.
- `_load_from_db / _build_index / _keyword_fallback`: hybrid retrieval.
- `judge_candidates(context, candidates)`: LLM rerank.
- `suggest_for_session(context, limit)`: top-N suggestions for surface.
- `get_skill_content(name)`.
- `dismiss_skill(session, entity_id) / clear_session / index_status`.

### 19h · backend/skills_client.py — Anthropic skills repo client
- `_load_catalog / _parse_frontmatter`.
- `_fetch_repo_skills(session, repo) / _kick_github_fetch / _fetch_official_repos_bg`.
- `fetch_skills_index / fetch_skill_content(skill_path, repo)`.

---

## 20 · backend/auto_learn.py — extract lessons from finished sessions

- `_learn_from_session(session_id)`: full pipeline.
- `_load_session / _load_messages / _format_transcript`.
- `_extract_lessons(transcript, cli)`: LLM-extract → pending list.
- `_suggest_skills(transcript, session_id, ws)`: pair lessons with skills.
- `list_pending / approve / reject`: human-in-the-loop.
- `_on_session_event`: subscriber.
- `start(app) / stop(app)`: lifecycle.

## 20a · backend/session_advisor.py — guideline recommender
- `analyze_session(session_id)`: drives recommendations.
- `score_message(text) / score_message_batch(texts)`: per-message intent scoring.
- `_get_or_create_buffer(session, ws)`: rolling intent buffer.
- `get_intent_text(session) / clear_intent`.
- `dismiss_recommendation(session, guideline)`.
- `_ensure_anchors / _ensure_generality_counts / _generality_penalty`: guideline ranking.
- `_record_recommendation`: track to compute effectiveness.
- `_maybe_push_recommendations(session, broadcast)`: emit to UI.

auto_learn writes lessons to memory; session_advisor surfaces matching guidelines mid-session.

---

## 21 · backend/catchup.py — time-window digest

- `_parse_iso / _to_sqlite_format / _truncate_payload / _is_relevant_for_mode`.
- `_format_event_line / _ws_label`.
- `_list_workspaces`: include filter.
- (Main entrypoint is `catchup_handler` in server.py; this module owns event grouping + summary text.)

---

## 22 · backend/preview_browser.py — Playwright-backed preview share

- `_ensure_browser()`: lazy-spawn Chromium.
- `claim_driver / get_driver / unsubscribe / subscriber_count`: driver/viewer model.
- `_send_keyframe / _fanout_frame / _on_nav`: frame plumbing.
- `_safe_invoke / _broadcast_driver_change / _teardown_after_grace`.
- `stop_preview / send_input / navigate / get_current_url / screenshot_png / resize`.
- `normalize_preview_url / share_key_for / active_previews / shutdown`.
- `_modifiers(event)`: keyboard mods.

## 22a · backend/demo_runner.py — per-workspace dev server proxy
- `start / stop / status / list_all / pull_latest / shutdown_all`.
- `_spawn(demo) / _terminate(demo)`: subprocess control.
- `_run_subprocess / _read_log / _append_log / _broadcast_state / _broadcast_log`.
- `_git_head / _git_pull / _files_changed`: track upstream.
- `_pick_free_port`.

## 22b · backend/account_sandbox.py — auth isolation
- `snapshot_current_auth(account_id, cli)`: copy ~/.claude or ~/.gemini.
- `get_sandbox_home / has_snapshot / claude_config_dir / has_isolated_claude_credentials / delete_snapshot`.

## 22c · backend/auth_cycler.py — playwright-driven multi-account login
- `_llm_steer(page, key, goal, max_steps)`: LLM-steer browser to complete login.
- `_heuristic_steer(page)`: fallback.
- `_make_url_catcher / _poll_file / _is_callback_url / _resolve_cli / _find_api_key`.

---

## 23 · Misc backend

### git_ops.py
- `_run(args, cwd, timeout) → (stdout, stderr, code)`.
- `git_status(workspace_path) / git_log(workspace_path, count)`.

### history_reader.py — claude/gemini transcript ingest
- `list_projects / _list_claude_projects / _list_gemini_projects / _list_gemini_sessions / _reverse_gemini_hash`.
- `list_project_sessions / read_session_messages / _read_jsonl_session / _read_gemini_session`.
- `normalize_jsonl_entry(entry)`: unify shapes.
- `export_session_as_markdown(messages)`.

### output_styles.py
- `get_style_prompt(style)`: returns style modifier prompt block.

### experimental.py
- `get_feature(key) / is_known_feature / features_as_dicts`: experimental flags catalog.

### telemetry.py
- `ping(event)`, `_heartbeat_loop / _heartbeat_coroutine / start_background / stop`.
- `report_error(type, msg, ctx) / report_error_sync`: opt-in error reporting.
- `_machine_id / _platform_tag / _build_payload / _is_enabled / _send`.

### mcp_exit_log.py
- `log_exit(reason, details) / install(server_name)`: capture MCP server crash reasons.

### commander_events.py
- `build_event_catalog() → list[dict]`: returns full event taxonomy with descriptions for UI.

### resource_path.py
- `is_frozen / backend_dir / project_root`: PyInstaller-aware paths.

### Middlewares
- `middleware/csp.py`: `csp_middleware`, `_csp_exempt`.
- `middleware/audit.py`: `audit_middleware`, `_should_audit / _peer_ip / _summary_for`.
- `middleware/rate_limiter.py`: `rate_limit_middleware`.

---

## 24 · Frontend — `src/lib/api.js` (~200 client methods)

Single fetch-wrapper namespace `api`. Categories below; every method ↔ a server.py route handler.

```
api.workspaces            list/create/update/delete/reorder/browseFolder/overview/git{Status,Diff,Log}/openInIde/screenshot
api.sessions              list/create/delete/rename/update/clone/merge/distill/summarize/search/exportSession/popOut
                          send/broadcastInput/getOutput/output captures/listMessages
                          switchCli/switchModel/health/restart/tree/subagents/transcript
api.scratchpad            get/update
api.queue                 getQueue/queueTask/assign
api.guidelines            list/create/update/delete/getSession/setSession/recommend/dismiss/effectiveness/analyze
api.mcp                   list/create/update/delete/parse/getSession/setSession
api.history               listProjects/import
api.prompts               list/create/update/delete/use/reorderQuickActions
api.templates             list/create/delete/apply
api.gridTemplates         list/create/update/delete
api.tabGroups             list/create/update/delete
api.tasks                 list/create/get/update/iterate/delete/listEvents
api.research              listJobs/start/decompose/steer/resume/stop · DB list/create/update/get/withSources/addSource/delete/search
api.researchSchedules     list/create/update/delete (cron rows)
api.cascades              list/create/update/delete/use · runs list/create/get/update/delete
api.pipelines             listDef/createDef/getDef/updateDef/deleteDef · runs list/start/get/update/delete · startRalph
api.broadcastGroups       list/create/update/delete
api.appSettings           list/get/put/getAppSetting (alias)
api.experimental          list
api.safety                rules CRUD/seed · decisions/proposals/accept/dismiss/reportApproved/status
                          installScriptPolicy get/put · allowlist add/remove · external/command/package logs
api.plugins               registries CRUD+sync · plugins list/get/install/uninstall · session components get/set
api.accounts              list/create/update/delete/test/openBrowser/openNext/snapshot/restartWith · playwright setup/auth/authStatus
api.w2w                   peerMessages list/create/markRead · digest get/update · knowledge list/get/create/update/delete/prompt
                          fileActivity get/recent · similarSessions/Tasks/checkOverlap/unifiedSearch/exportToConfig
api.memory                entries list/create/update/delete/search · workspace get/update/sync/diff/resolve/settings/auto/import/export/compact · autofillVision
api.observatory           findings list/update/delete/promote · profile get/regen/update/recalib · targets list/add/update/delete/plan · triage · smartScan/scan
                          insights list/upsert/update/delete · scans list · settings get/update · apiKeys get/set/test
api.skills                list/get/install/uninstall/sync/search/getContent/dismissSuggestion · listInstalled
api.apiKeys               list/save/test
api.invites               create/list/revoke/redeem
api.auth                  login/logout/whoami/sessions list/revoke
api.runtime               status/tunnelStart/tunnelStop/setMode/multiplayerToggle
api.audit                 listLog
api.catchup               getCatchup({since, until, limit, model, cli?})  — model→cli inferred backend-side
api.push                  subscribe/unsubscribe/vapidPublicKey
api.devices               pairInit/challenge/pairComplete/list/revoke
api.docs                  status/triggerBuild · getAgentsMd/saveAgentsMd
api.eventsApi             list/catalog/emit · subscriptions list/create/update/delete
api.testQueue             list/enqueue/remove/update
api.demos / demoApi       get/start/stop/pullLatest/listAll/log
api.preview               proxy URL builders, screenshot, take
api.attachments           upload/serve/list, paste image
api.planFiles             list/get/put
api.autolearn             listPending/approve/reject
helpers                   isLocalOrigin/localPreviewUrl/rewriteLocalPreviewUrl
```

Helper functions exported from constants/etc:
- `getModelsForCli(cli) / getPermissionModesForCli / getEffortLevelsForCli / getDefaultModel / getDefaultPermissionMode / getCliCapability / getMessageMarkers`: profile-driven, fall back to static MODELS/GEMINI_MODELS when cliProfiles unloaded.
- `getWorkspaceColor(workspace)`: hash workspace.id → palette.
- `isVaguePrompt(text)`: heuristic guard for prompt-quality nudge.

---

## 25 · Frontend — `src/state/store.js` (Zustand)

Single global store. Top-level slices (selectors expected): `workspaces`, `sessions`, `activeSessionId`, `splitPrimaryId`, `splitSessionId`, `tabGroups`, `gridTemplates`, `cliProfiles`, `appSettings`, `safetyState`, `observatory`, `pipelines`, `cascades`, `tasks`, `peerMessages`, `digests`, `knowledge`, `memoryEntries`, `experimentalFlags`, `accounts`, `runtime`, `auth`, `prompts`, `mcpServers`, `skills`, `plugins`, `notifications`, `commandPalette`, `previewState`.

Key invariants:
- `splitPrimaryId` ≠ `splitSessionId` to consider split active; `activeSessionId` is global focus and **must not** be conflated with `splitPrimaryId` (gotcha-confirmed in workspace knowledge).
- `cliProfiles[cliType]` shape drives all per-CLI gating helpers in constants.js.

(Store actions are typically named verbs: `setActiveSession / addSession / removeSession / patchSession / replaceSessions / setSplit / clearSplit / loadCliProfiles / setAppSetting / addPeerMessage / markPeerMessageRead / setDigest / pushNotification / dismissNotification`.)

---

## 26 · Frontend — `src/hooks/`

- `useWebSocket.js`: opens `/ws`, dispatches incoming events to store, exposes `send(event)`. Reconnect with backoff. ◆subscribes to broadcast() events.
- `useKeyboard.js`: global keymap (cmd-k palette, cmd-/ search, cmd-enter send, cmd-shift-, settings). Dispatches via `keybindings.js`.
- `useListKeyboardNav.js`: arrow-key list nav for command palette / search results.
- `useMediaQuery.js`: responsive breakpoints.
- `usePanelCreate.js`: factory for opening side panels (memory, knowledge, etc.).
- `useVoiceInput.js`: webkitSpeechRecognition wrapper for Composer dictation.

---

## 27 · Frontend — `src/lib/` helpers

- `terminal.js`: xterm.js factory: builds a Terminal with theme, addons (fit, web-links, search), wires resize → backend.
- `terminalWriters.js`: pretty-print injected status lines (warnings, peer messages, role banners) into xterm without breaking ANSI.
- `terminalInputTracker.js`: track raw user keystrokes per session, split on Enter, store turns ↔ `_track_input`.
- `outputParser.js`: parse ANSI-stripped output into structured chunks (tool blocks, code blocks, markdown).
- `syntaxHighlight.js`: prismjs/highlight.js shim with lazy language loading.
- `diffParser.js`: parse `git diff` text → file/hunk tree for `CodePreview` and `MemoryWindow.resolve`.
- `cascadeVariables.js`: parse `{{var}}` placeholders out of a cascade step template, validate user fills.
- `commandActions.js`: registry of command-palette actions (open settings, switch model, run cascade, etc.) — single dispatch table consumed by `CommandPalette`.
- `keybindings.js`: keyboard-shortcut registry mapping chord → action id.
- `pushClient.js`: register service worker + push subscription, post to `api.push.subscribe`.
- `sounds.js`: soft-bell on notification / done / error events.
- `tokens.js`: count tokens for composer (tiktoken-lite or simple heuristic).
- `uuid.js`: `crypto.randomUUID()` with fallback.

---

## 28 · Frontend — components (selected; ~70 jsx files)

(Each is a default-export React function; props ≈ store-slice subset + callbacks.)

### Layout
- `App.jsx`: root layout (Sidebar | main), reads `splitPrimaryId/splitSessionId/activeSessionId`, renders Terminal + side panels.
- `layout/Sidebar.jsx`: workspaces list, sessions tree, drag-reorder.
- `layout/TopBar.jsx`: workspace switch, mode badge, command palette button, account switcher dropdown (clipped-by-overflow gotcha).
- `layout/StatusBar.jsx`: bottom strip — git status, demo state, peer count, tunnel state.
- `layout/MailboxPill.jsx`: peer-message count + popover.
- `layout/MobileDrawer.jsx`: mobile-only nav.
- `layout/NotificationToast.jsx`: transient toast renderer (NOT for non-blocking suggestions per project guidelines).

### Session
- `session/SessionTabs.jsx`: tab strip per workspace; supports tab groups + drag.
- `session/MissionControl.jsx`: per-session right-panel controls (model/permission switch, scratchpad toggle, etc.).
- `session/Scratchpad.jsx`: free-form notes per session.
- `session/Inbox.jsx`: peer messages addressed to this session.
- `session/PeerMessagesPanel.jsx`: full bulletin board for the workspace.
- `session/MemoryWindow.jsx`: 3-way memory merge UI; consumes `api.memory.workspace.diff/resolve`.
- `session/KnowledgePanel.jsx`: workspace_knowledge browser/editor.
- `session/DistillPanel.jsx`: distill conversation → memory entry / pattern.
- `session/SubagentTree.jsx`: live tree of nested subagents (Task tool).
- `session/SubagentViewer.jsx`: per-subagent transcript drawer.
- `session/CodePreview.jsx`: diff viewer.
- `session/CodeReviewPanel.jsx`: per-PR review surface.
- `session/ConfigViewer.jsx`: dump of session config (cli, model, MCP servers, hooks).
- `session/DocsPanel.jsx`: docs build + preview.
- `session/HistoryImport.jsx`: pull from ~/.claude or ~/.gemini.
- `session/MergeDialog.jsx`: merge two sessions into one.
- `session/MermaidBlock.jsx`: render mermaid in transcripts.
- `session/PlanViewer.jsx`: plan_files viewer.
- `session/ResearchHub.jsx`: research jobs UI (decompose/steer/resume/stop).
- `session/ResearchPlanPanel.jsx`: edit research plan.
- `session/ScreenshotAnnotator.jsx`: paint over a screenshot before saving.

### Chat / terminal
- `chat/Terminal.jsx`: xterm host; subscribes to /ws output events for `activeSessionId` (or split panel id).
- `chat/Composer.jsx`: input, model selector, attachments, voice, queue button.
- `chat/BroadcastBar.jsx`: send to broadcast group.
- `chat/CascadeBar.jsx`: progress strip when a cascade is running.
- `chat/ForceBar.jsx`: claude-only "force send / re-prompt" affordance.
- `chat/TokenChips.jsx`: live token count chips.
- `chat/TerminalAnnotator.jsx / chat/TerminalTokenBadge.jsx / chat/ImageAnnotator.jsx`.

### Command palettes
- `command/CommandPalette.jsx`: cmd-k.
- `command/QuickActions.jsx`: pinned bar; non-blocking suggestions appear here per UX rule.
- `command/QuickActionPalette.jsx`.
- `command/PromptPalette.jsx` / `prompts/PromptPalette.jsx`.
- `command/PreviewPalette.jsx`: preview targets.
- `command/SearchPanel.jsx`: workspace-wide search.
- `command/ShortcutsPanel.jsx`: keymap.
- `command/AccountManager.jsx`: list/snapshot/test.
- `command/DemoPanel.jsx`: dev-server runner UI.
- `command/FloatingCommandButton.jsx`: mobile FAB.
- `command/GridTemplateEditor.jsx`: grid layout editor.
- `command/LivePreview.jsx`: shared preview viewer (preview_browser frames).
- `command/TemplateManager.jsx`: session templates.

### Catchup / settings / observatory / etc.
- `catchup/CatchUpBanner.jsx`: top strip when last-seen is stale; reads `catchup_model` setting; calls `api.getCatchup({since, model})`. Self-loads, dismiss persists per session.
- `catchup/CatchUpPanel.jsx`: modal; renders `initialDigest` without re-fetching; rebriefs only on explicit time-window change. `modelRef` (NOT state) avoids effect retrigger.
- `settings/GeneralSettingsPanel.jsx`: catchup_model, research_model, idle_reflection toggles, etc.
- `settings/ApiKeysPanel.jsx / ExperimentalPanel.jsx / SafetyPanel.jsx / SharingPanel.jsx / SoundSettingsPanel.jsx / WorkspaceSettingsPanel.jsx`.
- `observatory/SmartObservatoryPanel.jsx / FindingCard.jsx`.
- `pipeline/PipelineEditor.jsx`: graph editor for pipeline_definitions.
- `prompts/CascadeVariableDialog.jsx / CascadeVariableEditor.jsx`.
- `marketplace/MarketplacePanel.jsx`: plugin/skill marketplace.
- `mcp/McpPanel.jsx`: MCP server CRUD.
- `guidelines/GuidelinePanel.jsx`: guideline CRUD + recommend feed.
- `board/FeatureBoard.jsx`, `board/TaskCard.jsx`, `board/TaskDetailModal.jsx`, `board/NewTaskForm.jsx`, `board/QuickFeatureModal.jsx`, `board/DependencyGraph.jsx`, `board/ExcalidrawWrapper.jsx`: kanban + dependency graph.
- `mobile/MobileInstallPrompt.jsx`.
- `onboarding/FirstLaunchOnboarding.jsx`, `workspace/WorkspaceVisionOnboarding.jsx`.
- `auth/ModeBadge.jsx`: shows runtime mode (owner/joiner/brief).
- `ErrorBoundary.jsx`: top-level error catcher.

---

## 29 · Cross-cutting flows (who-calls-who at runtime)

### Prompt sent
```
Composer → api.sessions.send → server.send_session_input → pty.write
                                                          ↓
                                    hook.sh → POST /api/hooks (PreToolUse)
                                                          ↓
                                    handle_hook_event → _handle_pre_tool_use
                                                          ↓
                                    safety_engine + AVCP scan + w2w_check_file_conflict
                                                          ↓
                                    allow → tool runs → PostToolUse → file_activity emit
                                                          ↓
                                    Stop → idle_reflection schedule (300s)
                                                          ↓
                                    PTY exit → _maybe_auto_distill / extract / summarize
```

### W2W coordination
```
Worker A intends to edit X.py
  → tool_get_file_context(X.py) → server.get_file_context → file_activity table
  → tool_coord_check_overlap → peer_comms.myelin_check_overlap → cosine vs B's digest
  → if overlap≥0.80 → blocking_bulletin → POSTs peer_message(blocking) → B's session sees in Inbox
  → B replies → A unblocks
```

### Pipeline (RALPH preset)
```
start_ralph_pipeline(task) → pipeline_engine.start_ralph
  → _execute_stage(execute) → spawn worker session → send prompt
  → on session idle → on_session_idle → _capture_output_summary
  → _evaluate_condition → branch:
       success  → _complete_stage(verify) → tester session
       partial  → _increment_iteration → re-execute
  → tester _on_test_completed → handle_pipeline_result
  → if fail → _route_back_to_implementor(failure_details)
  → if pass → _route_to_documentor → docs build → _complete_pipeline
```

### Catchup briefing
```
CatchUpBanner mount → readLastSeen → if >30min stale →
  → api.getAppSetting('catchup_model') → 'haiku'|'sonnet'|'gemini-2.5-flash'
  → api.getCatchup({since, limit, model})
  → catchup_handler routes by model prefix → llm_router.llm_call(cli, model, prompt)
  → returns digest{summary, summary_source, total_events, commits, memory_changes, events}
  → banner renders summary; click View → CatchUpPanel(initialDigest=digest)
  → panel only re-briefs on user time-window action
```

### Observatory smart scan
```
trigger_observatory_smart_scan(ws)
  → observatory_profile.get_profile(ws)         # cached, regen on hash mismatch
  → observatory_smart.scrape_for_target(target) for each saved target
  → observatory_profile.triage_items(profile, items)  # LLM relevance filter
  → for each kept item → observatory_smart.voice_extract → workspace_insights table
  → broadcast finding event → SmartObservatoryPanel updates
```

### Memory sync (3-way merge)
```
User edits ~/.claude/CLAUDE.md externally
  → file watcher → memory_sync.is_memory_path → POST /api/workspaces/.../memory/sync
  → compare current_db_content / disk_content / last_seen_hash via _sha256
  → if conflict → return diff via memory_sync.git_diff
  → MemoryWindow renders side-by-side → user picks → resolve_workspace_memory writes back
  → providers (CLAUDE.md / GEMINI.md) updated → workspace_memory.last_synced_at bumped
```

---

## 30 · Database schema map (selected tables in `db.init_db`)

```
workspaces           id, name, path, color, vision, created_at, sort_order
sessions             id, workspace_id, name, cli_type, model, permission_mode, native_id, status, ...
session_outputs      session_id, ts, data           # transcript chunks
events               id, ts, name, payload_json     # event_bus log
peer_messages        id, workspace_id, from_session, to_session, topic, content, priority, files_json, created_at, read_at
session_digests      session_id, summary, discoveries, decisions, embedding
workspace_knowledge  id, workspace_id, category, content, scope, embedding, created_by_session
file_activity        workspace_id, file_path, session_id, tool_name, ts
memory_entries       id, workspace_id|null(global), name, description, type, content, embedding
workspace_memory     workspace_id, content, providers_json (per-cli hashes), last_synced_at
tasks                id, workspace_id, title, body, status, priority, deps_json, embedding, pipeline_stage, ...
task_events          task_id, name, payload, ts
pipeline_definitions id, workspace_id, name, dag_json, presets
pipeline_runs        id, definition_id, status, current_stages, iteration, vars_json
cascades             id, workspace_id, name, steps_json (with {{vars}})
cascade_runs         id, cascade_id, session_id, step_idx, status, vars_json
observatory_findings id, workspace_id|null, source, payload, analysis, status
observatory_profile  workspace_id, profile_json, hash, prose
workspace_insights   id, workspace_id, type, content, source_finding
search_targets       id, workspace_id, source, target_type, value, hits, yielded, last_scan_at
safety_rules         id, name, category, severity, tool_match, pattern, action, pattern_field
safety_decisions     id, session_id, tool_use_id, allowed, reason, ts
safety_proposals     id, signature, suggested_rule, count, dismissed_at
plugin_registries    id, name, url, last_synced, last_error
plugins              id, registry_id, name, manifest_json, installed
plugin_components    id, plugin_id, kind, name, body
session_components   session_id, component_id, enabled
test_queue           id, workspace_id, target_session, prompt, status, created_at
auto_learn_pending   id, session_id, lesson, status (pending/approved/rejected)
guidelines           id, workspace_id|null, name, content, embedding, anchor, generality
guideline_recs       session_id, guideline_id, dismissed, ts
audit_log            id, ts, actor, ip, method, path, status, summary
api_keys             name, value (encrypted)
invites              id, secret_hash, label, expires_at, attempts, used_by
joiner_sessions      id, invite_id, cookie_hash, created_at, revoked_at
devices              id, public_key, fingerprint, label, paired_at
push_subscriptions   id, actor_kind, actor_id, endpoint, p256dh, auth
research_jobs        id, query, status, plan_json, results_json
research_db          id, workspace_id, title, content, sources_json
research_schedules   id, query, cron, last_run_at
prompts              id, workspace_id|null, name, body, quick_action_order
mcp_servers          id, name, config_json
session_mcp          session_id, mcp_server_id
agent_skills         id, name, description, body, source_repo, embedding
session_skills       session_id, skill_id, dismissed
broadcast_groups     id, name, session_ids_json
event_subscriptions  id, trigger, action_json
app_settings         key, value
experimental_flags   key, enabled
runtime_state        key, value (mode, multiplayer, tunnel_url, ...)
```

---

## 31 · Reading guide

If you're new and want to trace one feature end-to-end, start here:
- **A prompt's life** → §29 "Prompt sent".
- **How workers stay out of each other's way** → §29 "W2W coordination" + §10 peer_comms + §7b worker MCP.
- **How auto-loops drive themselves** → §12 (pipelines/cascades/auto_exec/worker_queue) + §8 idle_reflection + §4 event_bus.
- **How the catchup banner surfaces** → §29 "Catchup briefing" + §1 catchup_handler + frontend §28 catchup/*.
- **How memory stays consistent across CLAUDE.md/GEMINI.md and the DB** → §29 "Memory sync" + §14a memory_sync + §1 memory routes.
- **What every backend module owns** → §1–§24 in order.
- **What the frontend can call** → §24 api.js surface, grouped by domain.

---

## 32 · `backend/pty_manager.py` — PTY lifecycle

Owns child-process terminals (`claude`, `gemini`) behind every session. Pure POSIX `pty.openpty` + `os.fork`/`execvpe`; loop integration via `loop.add_reader`.

```
PTYSession
  __init__(session_id, workspace_path, cols=120, rows=40, cmd_args=None, extra_env=None, cmd_binary="claude"):
    holds master_fd, pid, output_cb, exit_cb, _output_cache (bytes, capped 1MB), _lock, _alive, _exit_cb_ran.
  start(output_cb, exit_cb): pty.openpty → fork; child sets TIOCSWINSZ, chdirs, execvpe; parent registers loop.add_reader and schedules _wait_exit. ◆spawns subprocess
  _on_readable(): os.read(master_fd, 65536); on EOF, remove_reader + _close_fd. Caches last 1MB. →output_cb
  get_cached_output() -> bytes: returns rolling buffer (used by reconnecting xterm clients to repaint).
  _wait_exit(): asyncio.to_thread(os.waitpid); fires exit_cb once. ◆marks _alive=False
  _close_fd(): loop.remove_reader + os.close under _lock; idempotent.
  write(data: bytes) -> bool: os.write(master_fd, data) under _lock; False if dead.
  resize(cols, rows): clamps to [1, 9999], fcntl TIOCSWINSZ struct.pack("HHHH", rows, cols, 0, 0).
  terminate(): SIGINT now → SIGTERM at +2s → SIGKILL at +5s via _escalate_kill.
  _escalate_kill(sig): os.kill(pid, sig) if still alive; suppresses ProcessLookupError.

PTYManager
  on_output(cb) / on_exit(cb): registers global callbacks; PTY events fan out to all listeners.
  start_session(session_id, workspace_path, cols, rows, cmd_args, extra_env, cmd_binary) -> PTYSession.
  write(session_id, data) / resize / is_alive / get_cached_output: thin dispatchers keyed by session_id.
  stop_session(session_id) / stop_all(): terminate + await waitpid.
```

**Output buffer**: `_OUTPUT_BUFFER_MAX = 1_048_576`. When a viewer (re)connects to an existing session WS, `get_cached_output()` is replayed before live frames begin — that's why xterm doesn't show empty terminals on tab switch.

**Spawn env**: `extra_env` is dict-merged onto `os.environ`; this is how `COMMANDER_CLI_TYPE`, `COMMANDER_API_URL`, `COMMANDER_SESSION_ID`, `COMMANDER_WORKSPACE_ID` reach hooks/MCP server.

---

## 33 · `deep_research/` — sibling research engine

Stand-alone Python package (not a backend module). Used both as a CLI (`python -m deep_research <cmd>`) and via backend's `research_engine.py`.

```
__main__.py
  main(): argparse subcommands: research / investigate / align / gather / profile / status.
  _cmd_research/_cmd_investigate/_cmd_align/_cmd_gather/_cmd_profile/_cmd_status: arg shape per command.
  _run_research(query, depth, model, output_dir, ...) -> path to markdown report.
  _run_investigate(question, evidence_path) / _run_align(evidence_path, plan_path).
  _check_steer_file(): loads .deep_research_steer.md if present (per-project research style guide).

extract.py
  extract_content(url, *, html=None) -> {url, title, text, ...}: trafilatura fast path → regex fallback.
  extract_multiple(urls, max_concurrency=8) -> list: gather + per-URL timeout.
  _trafilatura_extract(html, url) / _regex_extract(html, url) / _fetch_html(url, timeout=30).

codebase.py
  profile_codebase(root) -> dict: tree + language breakdown + git context for "what is this repo" prompts.
  _directory_tree(root, depth=3) / _language_breakdown(root) (extension counts) / _git_context(root) (origin url, branch, last commit).

llm.py
  parse_json_response(text) -> dict|list|None: strips ```json fences, lenient parse, repairs common LLM mistakes.
  _detect_backend(model_id) -> "claude"|"gemini"|"openai"|"ollama".
  class LLMClient(model_id, *, api_key=None, base_url=None):
    .chat(messages, *, temperature, max_tokens, json_mode=False) -> str.
    .embed(text) -> list[float] (only if backend supports).

model_router.py
  class TaskTier(Enum): SIMPLE / STANDARD / COMPLEX / EXPERT.
  class ModelInfo(name, size_b, quant, ctx_window, cost_per_1k, ...).
  class ModelRouter(*, available_models, prefer_local=False):
    .pick(tier: TaskTier) -> ModelInfo: matches tier to nearest model on size+ctx.
  classify_task(prompt) -> TaskTier: heuristic length/complexity scorer.
  _estimate_size(name) / _detect_quantization(name).

search.py
  class SearchResult(title, url, snippet, source, rank).
  class SearchProvider(ABC): .search(query, n=10) -> list[SearchResult].
  Concrete providers: DuckDuckGoSearch / BraveSearch (BRAVE_API_KEY) / ArxivSearch (XML feed) / SemanticScholarSearch / GitHubSearch (REST search) / SearXNGSearch (configurable base_url).
  rrf_fuse(rankings: list[list[SearchResult]], k=60) -> list[SearchResult]: reciprocal rank fusion across providers.
  class MultiSearch(providers, *, fuse=rrf_fuse): .search(query, n) -> list.
  build_search(config: dict) -> MultiSearch: factory honoring DR_SEARCH_* env.

researcher.py
  class DeepResearcher(query, *, llm, search, depth=2, output_dir):
    .run() -> markdown path: plan → search → fetch → extract → synthesize → write_report. Saves cite-tracked markdown.
  _slugify(text) -> str: filename-safe.

investigator.py
  class Investigator(question, evidence_path, *, llm): .run() -> {answer, citations}: targeted Q&A over an existing report.

aligner.py
  class Aligner(evidence_path, plan_path, *, llm): .run() -> {alignments[], gaps[]}: maps research findings to a project plan.

gatherer.py
  summarize_results(results, *, llm, max_per_source=3) -> str: condense before synthesis to fit ctx.

tools.py
  class ToolExecutor: small in-process tool dispatcher used by the deep_research CLI mode (separate from backend MCP).

config.py
  class DeepResearchConfig(model_router_cfg, search_cfg, output_dir, ...): from_env() factory; used by both __main__ and backend research_engine.
```

**Why a separate package**: deep_research can run standalone in any Python venv (no aiohttp/sqlite). Backend's `research_engine.py` thinly wraps it. The CLI is what the bundled `plugins/deep-research` plugin shells out to.

---

## 34 · `anti-vibe-code-pwner/` — AVCP supply-chain scanner

Self-contained "is this command sketchy?" scanner installed as a CLI hook for both Claude Code and Gemini CLI.

```
avcp                                — 106KB executable (single-file Python via shiv or PyInstaller).
hooks/claude-code.sh                — Claude PreToolUse hook (JSON stdout protocol).
hooks/gemini-cli.sh                 — Gemini BeforeTool hook (exit-code + stderr protocol).
hooks/shell-wrapper.sh              — generic stdin → avcp wrapper for ad-hoc shell intercept.
lib/scanner.py                      — heuristic + LLM scoring engine (31KB).
README.md / LICENSE.
```

### Hook protocols (subtle but critical)

```
hooks/claude-code.sh:
  reads stdin JSON: tool_input.command.
  runs: avcp intercept "$COMMAND" --threshold $THRESHOLD --reason-format json.
  emits to STDOUT: JSON {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny|ask|allow", "permissionDecisionReason"|"additionalContext": "..."}}.
  decision mapping: block→deny, warn→ask, allow→allow.
  exit code is always 0; Claude hook contract = JSON stdout.

hooks/gemini-cli.sh:
  reads stdin JSON: tool_input.command OR tool_input.script (Bash variants).
  runs the same avcp intercept.
  on block: writes message to STDERR + exit 2 (Gemini hook contract).
  on warn: TREATS AS BLOCK (exit 2) — Gemini has no "ask" tier in BeforeTool.
  on allow: exit 0, no stdout/stderr.
  NO JSON to stdout — that would corrupt Gemini's tool_input parser.
```

`lib/scanner.py` exposes scoring (regex-based heuristics for `curl|sh`, `eval`, base64-decoded shells, GitHub raw fetches, etc.) plus an LLM-graded path when available. Threshold defaults: block≥0.85, warn≥0.50, else allow.

---

## 35 · `ext-repo/myelin/` — Myelin coordination surface

Coordination surface for graph-memory: `myelin_remember` tool, namespace-scoped reads, simple cosine retrieval.

```
class Myelin(namespace, *, readable_namespaces=None, writable_namespaces=None, storage=None, embedder=None):
  __init__: defaults readable=[namespace], writable=[namespace]; auto-detects embedder if None.
  can_read(target_namespace) / can_write(target_namespace) -> bool: pattern match against readable/writable lists.
  read_scope (property) -> list[str]: namespaces this instance is allowed to read.
  org_prefix (property) -> str: derived from namespace ("acme/team/alice" → "acme").
  _ensure_init(): lazy storage/embedder bootstrap (idempotent).
  execute(tool_name, args) -> dict: ONLY supports tool_name="myelin_remember". Stores a graph node with kind+content+embedding.
  list_nodes(kind=None, q=None, namespace=None, limit=20) -> list: query by kind, then optionally cosine-rank against q's embedding inside read_scope.
  get_node(node_id) -> dict | None.
  update_node(node_id, updates: dict) -> dict: patch node; namespace immutable.
  _resolve_read_scope(override_namespace) -> list[str]: respects can_read for cross-namespace reads.

_cosine_sim(a, b) -> float: numpy-free dot/norm.
_derive_label(dense, max_len=60) -> str: truncate-with-ellipsis for human-readable node labels.
_matches_any(namespace, patterns) -> bool: glob-style "acme/*" matching.
_derive_prefix(namespace) -> str: take first segment.
```

**Storage**: `SQLiteStorage` (BLOB embedding column). **Embedder**: `auto_detect_embedder()` picks `GeminiEmbedding` (text-embedding-004) when `GEMINI_API_KEY` is set, else falls back to a stub.

**How IVE uses it**: Commander/worker MCP both can construct a `Myelin(namespace=workspace_id, ...)` and call `.execute("myelin_remember", ...)` for cross-session graph memory. Distinct from local memory_entries (which are SQLite rows in the IVE DB) — Myelin can be pointed at a shared remote storage in multiplayer.

---

## 36 · `plugins/deep-research/` and `plugins/hf-explorer/` — bundled plugin examples

Two reference plugins shipped in-tree to exercise the plugin loader. Manifest schema (extracted by reading both):

```json
{
  "name": "deep-research",
  "version": "0.1.0",
  "description": "Multi-source web research with RRF fusion + extraction.",
  "source_format": "commander",
  "security_tier": 1,
  "components": [
    { "type": "guideline", "name": "deep-research", "activation": "always",
      "file": "SKILL.md", "skippable": true }
  ],
  "mcp_server": {
    "name": "deep-research",
    "command": "python",
    "args": ["-m", "plugin_mcp"],
    "env": { "COMMANDER_API_URL": "http://127.0.0.1:5111" }
  }
}
```

Field semantics:
- `source_format: "commander"` — distinguishes IVE-native plugins from imported Claude Code plugins (which would say `"claude_code"`).
- `security_tier` (1–3): 1 = bundled/trusted, 2 = official, 3 = community. Loader decides whether to require user confirmation at install.
- `components[].activation`: `"always"` | `"on_match"` | `"manual"`.
- `components[].skippable: true` lets the user bypass the guideline without uninstalling.
- `mcp_server.env`: merged into spawn env; `COMMANDER_API_URL` is how the plugin's MCP server talks back to backend (calls `/api/research/...` via http rather than re-implementing).

`plugins/hf-explorer/manifest.json` has the same shape; its MCP exposes `hf_search`, `hf_model_info`, `hf_download`.

---

## 37 · Frontend root files

```
frontend/index.html             — Vite entry: <div id="root">, <script type="module" src="/src/main.jsx">, links favicon.svg + manifest.webmanifest, theme-color meta = #09090b.
frontend/vite.config.js         — plugins=[react(), tailwindcss()]. server.port=5173. Proxy: '/api' → 'http://127.0.0.1:5111'; '/ws' → same with ws:true (upgrade for WebSocket). All API + WS during dev go through this proxy.
frontend/package.json           — React 19.2, ReactDOM 19.2, Vite 8, @vitejs/plugin-react 5, Tailwind 4.2 (@tailwindcss/vite plugin), Zustand 5, xterm 5.5 + xterm-addon-fit + xterm-addon-web-links, mermaid 11.14, lucide-react, qrcode.react, react-markdown 9, remark-gfm 4, fuse.js. Scripts: dev / build / preview / lint.
frontend/src/main.jsx           — createRoot(document.getElementById('root')).render(<StrictMode><ErrorBoundary><App/></ErrorBoundary></StrictMode>). After first paint, if import.meta.env.PROD, navigator.serviceWorker.register('/sw.js'). Skipped in dev so HMR keeps working.
frontend/src/App.jsx            — root component; imports the panel set (terminal, sessions, settings, knowledge, research, peer_comms, mcp, skills, prompts, broadcast, audit, etc.), hooks (useWebSocket, useKeyboard, useMediaQuery, useStore selectors), defines a class PanelBoundary extends React.Component for per-panel error isolation. Layout: TopBar + LeftSidebar + PanelHost + (optional) split right pane + CatchUpBanner + Toaster.
frontend/public/sw.js           — service worker. CACHE_NAME='ive-shell-v1'. SHELL=['/', '/index.html', '/favicon.svg', '/manifest.webmanifest']. Excluded from cache: '/api/', '/ws', '/preview/', '/auth', '/join'. Cache-first for shell; on offline navigation, fallback to '/index.html'. Push handler: dedupes by tag, click opens existing window if any (else opens '/').
frontend/public/manifest.webmanifest — PWA: name="IVE", short_name="IVE", display="standalone", theme_color/background_color="#09090b", icons=[favicon.svg as maskable].
frontend/public/favicon.svg     — single dark-mode logo.
```

**Service-worker gotcha**: SW only registers in `import.meta.env.PROD`. In dev, you'll see no SW activity in DevTools — that's intentional so Vite HMR isn't intercepted.

**Vite proxy gotcha**: `/ws` proxy needs `ws: true`; without it, WebSocket upgrade requests get 400. All multiplayer tunneling assumes this single port.

---

## 38 · `start.sh` + `scripts/deploy-pages.sh` — entry & deploy

### `start.sh` (482 lines, the user-facing launcher)

```
flags:
  --multiplayer            switch to multiplayer mode (token-gated, optionally tunneled).
  --tunnel                 spawn cloudflared quick tunnel, write trycloudflare URL to runtime_state.
  --headless               no terminal UI; backend + (optional) tunnel only.
  --token <s>              join token override.
  --port <n>               backend port (default 5111). Vite always 5173.
  --host <h>               backend bind host (default 127.0.0.1; auto 0.0.0.0 in multiplayer).
  --recheck-deps           ignore stamp files, force-run check_deps.

functions:
  check_deps               python>=3.11, node>=20, git; PEP 668 detection (pip --break-system-packages probe).
  install_backend_deps     pip install -r backend/requirements.txt; on PEP 668 → ~/.ive/venv first.
  install_playwright_browser  python -m playwright install chromium (one-time, ~150MB). Stamp ~/.ive/.playwright-installed.
  prewarm_embedding_models    python -c "from fastembed import TextEmbedding; ..." for BAAI/bge-small-en-v1.5 (~33MB) + cross-encoder reranker (~23MB). Stamp ~/.ive/.embeddings-installed.
  auto_update_cli          checks @anthropic-ai/claude-code and @google/gemini-cli versions on npm; prompts to update.
  kill_port <port>         lsof + kill -9 (used to clear stale 5111/5173).

stamp files (skip work if newer than $(git rev-parse HEAD) of requirements):
  ~/.ive/.deps-checked.<sha-of-requirements.txt>
  ~/.ive/.playwright-installed
  ~/.ive/.embeddings-installed

dispatch:
  --headless         python -m backend.server (no Vite).
  default (dev)      concurrent: vite dev (frontend) + python -m backend.server (backend) + tail logs.
  --multiplayer      backend on 0.0.0.0, ensures token, optionally spawns cloudflared.
```

**Why a venv**: macOS 14+ Homebrew Python is "externally managed" (PEP 668). Plain `pip install` errors. `start.sh` detects this and bootstraps `~/.ive/venv` once.

### `scripts/deploy-pages.sh` (41 lines, marketing site deploy)

```
1. cd docs/ && npm run build          → docs/.vitepress/dist
2. mkdir _site/                       → assemble flat output
3. cp marketing/index.html _site/
4. cp marketing/ive-promo.mp4 _site/
5. cp -r docs/.vitepress/dist/* _site/docs/
6. echo "${PAGES_DOMAIN:-ive.dev}" > _site/CNAME
7. cd _site && git init -b gh-pages && git add . && git commit -m "deploy"
8. git push --force <origin> gh-pages
```

Flat layout: `/` = marketing landing, `/docs/*` = VitePress docs site. CNAME → ive.dev. Force push because gh-pages has no history retained.

---

## 39 · `docs/` — VitePress site

```
docs/.vitepress/             — VitePress config (theme, sidebar, github icon → michael-ra/ive).
docs/api/                    — REST endpoint reference (mirrors §1 routes).
docs/features/               — feature pages (catchup, sessions, peer-comms, w2w, ...).
docs/guide/                  — quickstart, install, multiplayer, plugins, skills.
docs/screenshots/            — png assets.
docs/public/                 — static assets bundled into output.
docs/docs_manifest.json      — declares which markdown pages exist; consumed by `request_docs_update` MCP tool.
docs/index.md                — landing page.
docs/package.json            — own deps: vitepress + nothing else heavy.
```

**docs_manifest.json**: enumerates pages so the `request_docs_update` MCP tool can route a change request to a known file (rather than letting an agent invent paths).

---

## 40 · Hook payload shapes — Claude vs Gemini

Both CLIs spawn hooks per tool call but use *incompatible* protocols. `backend/hook_installer.py` writes the right one based on `COMMANDER_CLI_TYPE`.

### Claude Code (PreToolUse, PostToolUse, UserPromptSubmit, Stop, …)

**Stdin** (JSON, one event per invocation):
```json
{
  "session_id": "...",
  "tool_name": "Bash",
  "tool_input": {"command": "rm -rf /"},
  "hook_event_name": "PreToolUse"
}
```

**Stdout** (JSON, controls the decision):
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny" | "ask" | "allow",
    "permissionDecisionReason": "..."           // when deny/ask
    // OR "additionalContext": "..."             // when allow but want to inject text
  }
}
```

Exit code is always 0 unless the hook itself crashed. Decision is purely from stdout JSON.

### Gemini CLI (BeforeTool, AfterTool, …)

**Stdin** (JSON, similar fields, slightly different keys):
```json
{
  "session_id": "...",
  "tool_name": "shell" | "bash" | ...,
  "tool_input": {"command": "..."} | {"script": "..."},
  "event": "BeforeTool"
}
```

**No stdout JSON.** Decisions come from exit codes and stderr:
- exit 0  → allow.
- exit 2  → block; stderr message is shown to the user/agent.
- other   → hook error (logged but doesn't block).

To inject context on allow, write the context to stderr and exit 0 (Gemini surfaces stderr to the agent transcript). There is no "ask" tier — `warn` → block.

**Why this matters**: AVCP, idle_reflection, and any custom hook author has to branch on `COMMANDER_CLI_TYPE`. The two failure modes ("Gemini sees JSON on stdout" and "Claude sees exit 2 with no JSON") both show up as confusing tool-rejected-without-reason behavior.

---

## 41 · What is *not* in this catalog

For honesty:
- `tests/` directory does not exist. There is no formal test suite — there are ad-hoc test scripts (`test_*.png` artifacts at repo root from a prior visual run, `test_queue` DB table for in-app test runs, but no pytest tree).
- Hook stubs in `backend/hook_installer.py` itself were summarized in §40 by behavior; the literal shell scripts are short shims that just exec `python -m backend.hooks <event>` with stdin piped through.

