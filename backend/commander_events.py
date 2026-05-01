"""Commander-level event vocabulary.

This is Commander's own event bus — a layer ABOVE the CLI hook layer. Where
`cli_features.HookEvent` covers Claude Code and Gemini CLI lifecycle events,
`CommanderEvent` covers Commander's own orchestration and state changes:

    • Task board (create / status change / plan / done / blocked / ...)
    • Sessions (spawn / clone / status / delete)
    • Commander orchestrator (broadcast / worker spawn)
    • Plugins (install / attach / registry sync)
    • Research DB
    • Capture / observability

Every state change that happens in Commander — whether driven by a UI click,
a REST call, an MCP tool call from the Commander agent, or a plugin — fires
a CommanderEvent through the central event bus. Plugins, webhooks, the live
UI feed, and audit logs all subscribe to that same stream.

Separation from HookEvent: keeping these in their own enum makes the source
of an event unambiguous ("this came from a CLI hook" vs "this is Commander's
own orchestration"). Plugins can subscribe to either or both.
"""
from __future__ import annotations

from enum import Enum


class CommanderEvent(str, Enum):
    """Canonical Commander orchestration events.

    Values are snake_case strings used as the event identifier in the
    audit log, WebSocket stream, webhook payloads, and subscription
    manifests. Plugin authors reference events by these string values.
    """

    # ── Task board ────────────────────────────────────────────────────
    TASK_CREATED            = "task_created"
    TASK_UPDATED            = "task_updated"
    TASK_STATUS_CHANGED     = "task_status_changed"
    TASK_ASSIGNED           = "task_assigned"
    TASK_STARTED            = "task_started"          # transitioned into in_progress
    TASK_PLAN_READY         = "task_plan_ready"       # plan-first worker is awaiting approval
    TASK_PLAN_APPROVED      = "task_plan_approved"
    TASK_PLAN_REJECTED      = "task_plan_rejected"
    TASK_COMPLETED          = "task_completed"        # transitioned into done
    TASK_BLOCKED            = "task_blocked"
    TASK_DELETED            = "task_deleted"
    TASK_RALPH_ITERATION    = "task_ralph_iteration"  # Ralph loop tick
    TASK_RALPH_COMPLETED    = "task_ralph_completed"  # Ralph loop finished

    # ── Sessions (Commander-level worker lifecycle) ───────────────────
    # Distinct from HookEvent.SESSION_START which is the CLI's own session
    # lifecycle. These fire when Commander itself creates/destroys sessions.
    SESSION_SPAWNED         = "session_spawned"
    SESSION_CLONED          = "session_cloned"
    SESSION_DELETED         = "session_deleted"
    SESSION_STATUS_CHANGED  = "session_status_changed"  # idle → running → exited
    SESSION_IMPORTED        = "session_imported"
    SESSION_EXPORTED        = "session_exported"
    SESSION_CLI_SWITCHED    = "session_cli_switched"    # claude ⇄ gemini

    # ── Commander orchestrator ────────────────────────────────────────
    COMMANDER_STARTED       = "commander_started"
    COMMANDER_BROADCAST     = "commander_broadcast"
    COMMANDER_SPAWNED_WORKER = "commander_spawned_worker"

    # ── Workspace ─────────────────────────────────────────────────────
    WORKSPACE_CREATED       = "workspace_created"
    WORKSPACE_UPDATED       = "workspace_updated"
    WORKSPACE_DELETED       = "workspace_deleted"

    # ── Plugin marketplace ────────────────────────────────────────────
    PLUGIN_INSTALLED        = "plugin_installed"
    PLUGIN_UNINSTALLED      = "plugin_uninstalled"
    PLUGIN_COMPONENT_ATTACHED   = "plugin_component_attached"
    PLUGIN_COMPONENT_DETACHED   = "plugin_component_detached"
    REGISTRY_ADDED          = "registry_added"
    REGISTRY_DELETED        = "registry_deleted"
    REGISTRY_SYNCED         = "registry_synced"
    REGISTRY_SYNC_FAILED    = "registry_sync_failed"

    # ── Research DB ───────────────────────────────────────────────────
    RESEARCH_CREATED        = "research_created"
    RESEARCH_UPDATED        = "research_updated"
    RESEARCH_COMPLETED      = "research_completed"
    RESEARCH_SOURCE_ADDED   = "research_source_added"

    # ── Guidelines ────────────────────────────────────────────────────
    GUIDELINE_ATTACHED      = "guideline_attached"
    GUIDELINE_DETACHED      = "guideline_detached"

    # ── Capture / observability ────────────────────────────────────────
    CAPTURE_CREATED         = "capture_created"        # Commander observed a tool call / edit
    PLAN_DETECTED           = "plan_detected"          # Claude plan artifact saved

    # ── MCP tool calls (when the commander agent uses Commander's MCP) ─
    MCP_TOOL_CALLED         = "mcp_tool_called"
    MCP_TOOL_FAILED         = "mcp_tool_failed"

    # ── Auto-exec & iteration ────────────────────────────────────────
    AUTO_EXEC_TASK_DISPATCHED = "auto_exec_task_dispatched"
    AUTO_EXEC_THROTTLED       = "auto_exec_throttled"
    TASK_ITERATION_REQUESTED  = "task_iteration_requested"
    TASK_EDIT_INJECTED        = "task_edit_injected"

    # ── Task Pipeline: implement → test → document loop ────────────
    PIPELINE_STARTED             = "pipeline_started"
    PIPELINE_TESTING_STARTED     = "pipeline_testing_started"
    PIPELINE_TEST_PASSED         = "pipeline_test_passed"
    PIPELINE_TEST_FAILED         = "pipeline_test_failed"
    PIPELINE_DOCUMENTING_STARTED = "pipeline_documenting_started"
    PIPELINE_COMPLETED           = "pipeline_completed"
    PIPELINE_MAX_ITERATIONS_HIT  = "pipeline_max_iterations_hit"
    TEST_QUEUE_ENTRY_COMPLETED   = "test_queue_entry_completed"

    # ── Worker queue: per-worker task auto-delivery ──────────────────
    WORKER_QUEUE_TASK_DELIVERED = "worker_queue_task_delivered"
    WORKER_QUEUE_EMPTY          = "worker_queue_empty"
    SESSION_TAGGED              = "session_tagged"

    # ── W2W: Worker-to-Worker communication ──────────────────────────
    PEER_MESSAGE_SENT       = "peer_message_sent"
    PEER_MESSAGE_READ       = "peer_message_read"
    DIGEST_UPDATED          = "digest_updated"
    KNOWLEDGE_CONTRIBUTED   = "knowledge_contributed"
    KNOWLEDGE_CONFIRMED     = "knowledge_confirmed"

    # ── Session Advisor ──────────────────────────────────────────────
    GUIDELINE_RECOMMENDED           = "guideline_recommended"
    SESSION_ANALYZED                = "session_analyzed"
    GUIDELINE_EFFECTIVENESS_UPDATED = "guideline_effectiveness_updated"

    # ── Skill Suggester ─────────────────────────────────────────────
    SKILL_SUGGESTED                 = "skill_suggested"

    # ── Idle reflection ─────────────────────────────────────────────
    IDLE_REFLECTION_FIRED           = "idle_reflection_fired"

    # ── Safety Gate ──────────────────────────────────────────────────
    SAFETY_RULE_TRIGGERED   = "safety_rule_triggered"
    SAFETY_RULE_PROPOSED    = "safety_rule_proposed"
    SAFETY_RULE_LEARNED     = "safety_rule_learned"

    # ── Oversight / permission detection ─────────────────────────────
    PERMISSION_QUESTION_DETECTED = "permission_question_detected"

    # ── Documentor ──────────────────────────────────────────────────
    DOCUMENTOR_STARTED       = "documentor_started"
    DOCS_UPDATE_NEEDED       = "docs_update_needed"
    DOCS_BUILD_COMPLETED     = "docs_build_completed"

    # ── Observatory ─────────────────────────────────────────────────
    OBSERVATORY_SCAN_STARTED    = "observatory_scan_started"
    OBSERVATORY_SCAN_COMPLETED  = "observatory_scan_completed"
    OBSERVATORY_FINDING_CREATED = "observatory_finding_created"
    OBSERVATORY_FINDING_PROMOTED = "observatory_finding_promoted"

    # ── Session Supervisor ─────────────────────────────────────────
    SESSION_CRASHED           = "session_crashed"
    SESSION_RESTART_ATTEMPTED = "session_restart_attempted"
    SESSION_RESTART_FAILED    = "session_restart_failed"

    # ── Access / invites ────────────────────────────────────────────
    INVITE_CREATED        = "invite_created"
    INVITE_REDEEMED       = "invite_redeemed"
    INVITE_BURNED         = "invite_burned"
    INVITE_REDEEM_FAILED  = "invite_redeem_failed"
    SESSION_MINTED        = "session_minted"
    SESSION_REVOKED       = "session_revoked"
    DEVICE_PAIRED         = "device_paired"
    DEVICE_UNPAIRED       = "device_unpaired"
    MODE_VIOLATION_BLOCKED = "mode_violation_blocked"
    BRIEF_APPROVAL_GIVEN  = "brief_approval_given"


COMMANDER_EVENT_LABELS: dict[CommanderEvent, str] = {
    # Task board
    CommanderEvent.TASK_CREATED:         "Task created",
    CommanderEvent.TASK_UPDATED:         "Task updated",
    CommanderEvent.TASK_STATUS_CHANGED:  "Task status changed",
    CommanderEvent.TASK_ASSIGNED:        "Task assigned to a session",
    CommanderEvent.TASK_STARTED:         "Task moved to in-progress",
    CommanderEvent.TASK_PLAN_READY:      "Plan ready for approval",
    CommanderEvent.TASK_PLAN_APPROVED:   "Plan approved",
    CommanderEvent.TASK_PLAN_REJECTED:   "Plan rejected",
    CommanderEvent.TASK_COMPLETED:       "Task completed",
    CommanderEvent.TASK_BLOCKED:         "Task blocked",
    CommanderEvent.TASK_DELETED:         "Task deleted",
    CommanderEvent.TASK_RALPH_ITERATION: "Ralph loop iteration",
    CommanderEvent.TASK_RALPH_COMPLETED: "Ralph loop completed",
    # Sessions
    CommanderEvent.SESSION_SPAWNED:         "Session spawned",
    CommanderEvent.SESSION_CLONED:          "Session cloned",
    CommanderEvent.SESSION_DELETED:         "Session deleted",
    CommanderEvent.SESSION_STATUS_CHANGED:  "Session status changed",
    CommanderEvent.SESSION_IMPORTED:        "Session imported",
    CommanderEvent.SESSION_EXPORTED:        "Session exported",
    CommanderEvent.SESSION_CLI_SWITCHED:    "Session CLI switched",
    # Commander orchestrator
    CommanderEvent.COMMANDER_STARTED:         "Commander session started",
    CommanderEvent.COMMANDER_BROADCAST:       "Commander broadcast sent",
    CommanderEvent.COMMANDER_SPAWNED_WORKER:  "Commander spawned a worker",
    # Workspace
    CommanderEvent.WORKSPACE_CREATED: "Workspace created",
    CommanderEvent.WORKSPACE_UPDATED: "Workspace updated",
    CommanderEvent.WORKSPACE_DELETED: "Workspace deleted",
    # Plugin marketplace
    CommanderEvent.PLUGIN_INSTALLED:          "Plugin installed",
    CommanderEvent.PLUGIN_UNINSTALLED:        "Plugin uninstalled",
    CommanderEvent.PLUGIN_COMPONENT_ATTACHED: "Plugin component attached",
    CommanderEvent.PLUGIN_COMPONENT_DETACHED: "Plugin component detached",
    CommanderEvent.REGISTRY_ADDED:            "Plugin registry added",
    CommanderEvent.REGISTRY_DELETED:          "Plugin registry deleted",
    CommanderEvent.REGISTRY_SYNCED:           "Plugin registry synced",
    CommanderEvent.REGISTRY_SYNC_FAILED:      "Plugin registry sync failed",
    # Research
    CommanderEvent.RESEARCH_CREATED:        "Research entry created",
    CommanderEvent.RESEARCH_UPDATED:        "Research entry updated",
    CommanderEvent.RESEARCH_COMPLETED:      "Research completed",
    CommanderEvent.RESEARCH_SOURCE_ADDED:   "Research source added",
    # Guidelines
    CommanderEvent.GUIDELINE_ATTACHED: "Guideline attached to session",
    CommanderEvent.GUIDELINE_DETACHED: "Guideline detached from session",
    # Capture
    CommanderEvent.CAPTURE_CREATED: "Output capture recorded",
    CommanderEvent.PLAN_DETECTED:   "Plan artifact detected",
    # MCP
    CommanderEvent.MCP_TOOL_CALLED: "MCP tool invoked",
    CommanderEvent.MCP_TOOL_FAILED: "MCP tool invocation failed",
    # Pipeline
    CommanderEvent.PIPELINE_STARTED:             "Pipeline started for task",
    CommanderEvent.PIPELINE_TESTING_STARTED:      "Pipeline routed task to tester",
    CommanderEvent.PIPELINE_TEST_PASSED:          "Pipeline tests passed",
    CommanderEvent.PIPELINE_TEST_FAILED:          "Pipeline tests failed",
    CommanderEvent.PIPELINE_DOCUMENTING_STARTED:  "Pipeline routed task to documentor",
    CommanderEvent.PIPELINE_COMPLETED:            "Pipeline completed",
    CommanderEvent.PIPELINE_MAX_ITERATIONS_HIT:   "Pipeline hit max iteration limit",
    CommanderEvent.TEST_QUEUE_ENTRY_COMPLETED:    "Test queue entry completed",
    # Auto-exec & iteration
    CommanderEvent.AUTO_EXEC_TASK_DISPATCHED: "Task auto-dispatched to Commander",
    CommanderEvent.AUTO_EXEC_THROTTLED:       "Auto-exec throttled (at worker limit)",
    CommanderEvent.TASK_ITERATION_REQUESTED:  "Task iteration requested",
    CommanderEvent.TASK_EDIT_INJECTED:        "Task edit injected into running session",
    # Worker queue
    CommanderEvent.WORKER_QUEUE_TASK_DELIVERED: "Queued task auto-delivered to worker",
    CommanderEvent.WORKER_QUEUE_EMPTY:          "Worker queue empty",
    CommanderEvent.SESSION_TAGGED:              "Session domain tags updated",
    # W2W
    CommanderEvent.PEER_MESSAGE_SENT:     "Peer message posted",
    CommanderEvent.PEER_MESSAGE_READ:     "Peer message read",
    CommanderEvent.DIGEST_UPDATED:        "Session digest updated",
    CommanderEvent.KNOWLEDGE_CONTRIBUTED: "Knowledge entry contributed",
    CommanderEvent.KNOWLEDGE_CONFIRMED:   "Knowledge entry confirmed",
    # Session Advisor
    CommanderEvent.GUIDELINE_RECOMMENDED:           "Guideline recommended for session",
    CommanderEvent.SESSION_ANALYZED:                 "Session quality analyzed",
    CommanderEvent.GUIDELINE_EFFECTIVENESS_UPDATED:  "Guideline effectiveness updated",
    # Skill Suggester
    CommanderEvent.SKILL_SUGGESTED:                  "Skills suggested for session",
    # Idle reflection
    CommanderEvent.IDLE_REFLECTION_FIRED:             "Idle reflection fired",
    # Safety Gate
    CommanderEvent.SAFETY_RULE_TRIGGERED: "Safety rule triggered",
    CommanderEvent.SAFETY_RULE_PROPOSED:  "Safety rule proposed from patterns",
    CommanderEvent.SAFETY_RULE_LEARNED:   "Safety rule learned from user behavior",
    # Oversight
    CommanderEvent.PERMISSION_QUESTION_DETECTED: "Session asking permission instead of acting",
    # Documentor
    CommanderEvent.DOCUMENTOR_STARTED:   "Documentor session started",
    CommanderEvent.DOCS_UPDATE_NEEDED:   "Documentation update requested",
    CommanderEvent.DOCS_BUILD_COMPLETED: "Documentation site built",
    # Observatory
    CommanderEvent.OBSERVATORY_SCAN_STARTED:    "Observatory scan started",
    CommanderEvent.OBSERVATORY_SCAN_COMPLETED:  "Observatory scan completed",
    CommanderEvent.OBSERVATORY_FINDING_CREATED: "Observatory finding created",
    CommanderEvent.OBSERVATORY_FINDING_PROMOTED: "Observatory finding promoted to task",
    # Session Supervisor
    CommanderEvent.SESSION_CRASHED:           "Session process crashed unexpectedly",
    CommanderEvent.SESSION_RESTART_ATTEMPTED: "Supervisor attempted to restart a session",
    CommanderEvent.SESSION_RESTART_FAILED:    "Supervisor failed to restart a session",
    # Access / invites
    CommanderEvent.INVITE_CREATED:       "Invite created",
    CommanderEvent.INVITE_REDEEMED:      "Invite redeemed",
    CommanderEvent.INVITE_BURNED:        "Invite revoked or auto-burned",
    CommanderEvent.SESSION_MINTED:       "Auth session minted",
    CommanderEvent.SESSION_REVOKED:      "Auth session revoked",
    CommanderEvent.DEVICE_PAIRED:        "Device paired",
    CommanderEvent.DEVICE_UNPAIRED:      "Device unpaired",
    CommanderEvent.MODE_VIOLATION_BLOCKED: "Mode violation blocked",
    CommanderEvent.BRIEF_APPROVAL_GIVEN: "Brief joiner gave thumbs-up",
    CommanderEvent.INVITE_REDEEM_FAILED: "Invite redemption attempt failed",
}


# Categories — used by UI to group subscriptions and filter events.
COMMANDER_EVENT_CATEGORIES: dict[CommanderEvent, str] = {
    CommanderEvent.TASK_CREATED:         "task_board",
    CommanderEvent.TASK_UPDATED:         "task_board",
    CommanderEvent.TASK_STATUS_CHANGED:  "task_board",
    CommanderEvent.TASK_ASSIGNED:        "task_board",
    CommanderEvent.TASK_STARTED:         "task_board",
    CommanderEvent.TASK_PLAN_READY:      "task_board",
    CommanderEvent.TASK_PLAN_APPROVED:   "task_board",
    CommanderEvent.TASK_PLAN_REJECTED:   "task_board",
    CommanderEvent.TASK_COMPLETED:       "task_board",
    CommanderEvent.TASK_BLOCKED:         "task_board",
    CommanderEvent.TASK_DELETED:         "task_board",
    CommanderEvent.TASK_RALPH_ITERATION: "task_board",
    CommanderEvent.TASK_RALPH_COMPLETED: "task_board",
    CommanderEvent.SESSION_SPAWNED:         "session",
    CommanderEvent.SESSION_CLONED:          "session",
    CommanderEvent.SESSION_DELETED:         "session",
    CommanderEvent.SESSION_STATUS_CHANGED:  "session",
    CommanderEvent.SESSION_IMPORTED:        "session",
    CommanderEvent.SESSION_EXPORTED:        "session",
    CommanderEvent.SESSION_CLI_SWITCHED:    "session",
    CommanderEvent.COMMANDER_STARTED:         "commander",
    CommanderEvent.COMMANDER_BROADCAST:       "commander",
    CommanderEvent.COMMANDER_SPAWNED_WORKER:  "commander",
    CommanderEvent.WORKSPACE_CREATED: "workspace",
    CommanderEvent.WORKSPACE_UPDATED: "workspace",
    CommanderEvent.WORKSPACE_DELETED: "workspace",
    CommanderEvent.PLUGIN_INSTALLED:          "plugins",
    CommanderEvent.PLUGIN_UNINSTALLED:        "plugins",
    CommanderEvent.PLUGIN_COMPONENT_ATTACHED: "plugins",
    CommanderEvent.PLUGIN_COMPONENT_DETACHED: "plugins",
    CommanderEvent.REGISTRY_ADDED:            "plugins",
    CommanderEvent.REGISTRY_DELETED:          "plugins",
    CommanderEvent.REGISTRY_SYNCED:           "plugins",
    CommanderEvent.REGISTRY_SYNC_FAILED:      "plugins",
    CommanderEvent.RESEARCH_CREATED:        "research",
    CommanderEvent.RESEARCH_UPDATED:        "research",
    CommanderEvent.RESEARCH_COMPLETED:      "research",
    CommanderEvent.RESEARCH_SOURCE_ADDED:   "research",
    CommanderEvent.GUIDELINE_ATTACHED: "guidelines",
    CommanderEvent.GUIDELINE_DETACHED: "guidelines",
    CommanderEvent.CAPTURE_CREATED: "observability",
    CommanderEvent.PLAN_DETECTED:   "observability",
    CommanderEvent.MCP_TOOL_CALLED: "mcp",
    CommanderEvent.MCP_TOOL_FAILED: "mcp",
    # Pipeline
    CommanderEvent.PIPELINE_STARTED:             "pipeline",
    CommanderEvent.PIPELINE_TESTING_STARTED:      "pipeline",
    CommanderEvent.PIPELINE_TEST_PASSED:          "pipeline",
    CommanderEvent.PIPELINE_TEST_FAILED:          "pipeline",
    CommanderEvent.PIPELINE_DOCUMENTING_STARTED:  "pipeline",
    CommanderEvent.PIPELINE_COMPLETED:            "pipeline",
    CommanderEvent.PIPELINE_MAX_ITERATIONS_HIT:   "pipeline",
    CommanderEvent.TEST_QUEUE_ENTRY_COMPLETED:    "pipeline",
    # Auto-exec & iteration
    CommanderEvent.AUTO_EXEC_TASK_DISPATCHED: "commander",
    CommanderEvent.AUTO_EXEC_THROTTLED:       "commander",
    CommanderEvent.TASK_ITERATION_REQUESTED:  "task_board",
    CommanderEvent.TASK_EDIT_INJECTED:        "task_board",
    # Worker queue
    CommanderEvent.WORKER_QUEUE_TASK_DELIVERED: "commander",
    CommanderEvent.WORKER_QUEUE_EMPTY:          "commander",
    CommanderEvent.SESSION_TAGGED:              "commander",
    # W2W
    CommanderEvent.PEER_MESSAGE_SENT:     "w2w",
    CommanderEvent.PEER_MESSAGE_READ:     "w2w",
    CommanderEvent.DIGEST_UPDATED:        "w2w",
    CommanderEvent.KNOWLEDGE_CONTRIBUTED: "w2w",
    CommanderEvent.KNOWLEDGE_CONFIRMED:   "w2w",
    # Session Advisor
    CommanderEvent.GUIDELINE_RECOMMENDED:           "advisor",
    CommanderEvent.SESSION_ANALYZED:                 "advisor",
    CommanderEvent.GUIDELINE_EFFECTIVENESS_UPDATED:  "advisor",
    # Skill Suggester
    CommanderEvent.SKILL_SUGGESTED:                  "advisor",
    # Idle reflection
    CommanderEvent.IDLE_REFLECTION_FIRED:             "session",
    # Safety Gate
    CommanderEvent.SAFETY_RULE_TRIGGERED: "safety",
    CommanderEvent.SAFETY_RULE_PROPOSED:  "safety",
    CommanderEvent.SAFETY_RULE_LEARNED:   "safety",
    # Oversight
    CommanderEvent.PERMISSION_QUESTION_DETECTED: "observability",
    # Documentor
    CommanderEvent.DOCUMENTOR_STARTED:   "documentor",
    CommanderEvent.DOCS_UPDATE_NEEDED:   "documentor",
    CommanderEvent.DOCS_BUILD_COMPLETED: "documentor",
    # Observatory
    CommanderEvent.OBSERVATORY_SCAN_STARTED:    "observatory",
    CommanderEvent.OBSERVATORY_SCAN_COMPLETED:  "observatory",
    CommanderEvent.OBSERVATORY_FINDING_CREATED: "observatory",
    CommanderEvent.OBSERVATORY_FINDING_PROMOTED: "observatory",
    # Session Supervisor
    CommanderEvent.SESSION_CRASHED:           "session",
    CommanderEvent.SESSION_RESTART_ATTEMPTED: "session",
    CommanderEvent.SESSION_RESTART_FAILED:    "session",
    # Access / invites
    CommanderEvent.INVITE_CREATED:       "access",
    CommanderEvent.INVITE_REDEEMED:      "access",
    CommanderEvent.INVITE_BURNED:        "access",
    CommanderEvent.SESSION_MINTED:       "access",
    CommanderEvent.SESSION_REVOKED:      "access",
    CommanderEvent.DEVICE_PAIRED:        "access",
    CommanderEvent.DEVICE_UNPAIRED:      "access",
    CommanderEvent.MODE_VIOLATION_BLOCKED: "access",
    CommanderEvent.BRIEF_APPROVAL_GIVEN: "access",
    CommanderEvent.INVITE_REDEEM_FAILED: "access",
}


def build_event_catalog() -> list[dict]:
    """JSON-serializable event catalog for /api/events/catalog.

    Used by the frontend to render subscription UIs, by plugin authors to
    discover what events exist, and by the marketplace to validate plugin
    manifests.
    """
    return [
        {
            "id": event.name,
            "value": event.value,
            "label": COMMANDER_EVENT_LABELS[event],
            "category": COMMANDER_EVENT_CATEGORIES[event],
        }
        for event in CommanderEvent
    ]


# Self-checks at import time — every enum member must have a label + category.
_missing_labels = [e for e in CommanderEvent if e not in COMMANDER_EVENT_LABELS]
assert not _missing_labels, f"missing COMMANDER_EVENT_LABELS for: {_missing_labels}"

_missing_categories = [e for e in CommanderEvent if e not in COMMANDER_EVENT_CATEGORIES]
assert not _missing_categories, f"missing COMMANDER_EVENT_CATEGORIES for: {_missing_categories}"
