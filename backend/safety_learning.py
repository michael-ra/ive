"""Safety Gate — decision logging and pattern learning.

Logs every safety evaluation and correlates PreToolUse/PostToolUse events
to detect user approve/deny patterns.  Periodically analyzes patterns and
proposes auto-rules.

The learning loop:
  1. Every evaluate() call logs to safety_decisions
  2. PostToolUse handler calls record_user_response() for correlation
  3. analyze_patterns() groups decisions and proposes rules
  4. User accepts/dismisses proposals in the UI
"""
from __future__ import annotations

import hashlib
import logging
import time
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)


# ─── Decision logging ───────────────────────────────────────────────────

async def log_decision(
    db,
    *,
    tool_use_id: Optional[str],
    session_id: Optional[str],
    workspace_id: Optional[str],
    tool_name: str,
    tool_input_summary: str,
    decision: str,
    reason: str,
    matched_rule_id: Optional[str],
    latency_ms: int,
):
    """Log a safety evaluation to the decisions audit table."""
    await db.execute(
        """INSERT INTO safety_decisions
           (tool_use_id, session_id, workspace_id, tool_name,
            tool_input_summary, matched_rule_id, decision, reason, latency_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            tool_use_id, session_id, workspace_id, tool_name,
            tool_input_summary[:500] if tool_input_summary else "",
            matched_rule_id, decision, reason, latency_ms,
        ),
    )
    await db.commit()


async def record_user_response(db, tool_use_id: str, response: str):
    """Update a decision record with the user's approve/deny response.

    Called from hooks.py when PostToolUse fires for a tool_use_id that
    has a pending safety decision.  If PostToolUse fires, the user approved.
    """
    await db.execute(
        """UPDATE safety_decisions
           SET user_response = ?
           WHERE tool_use_id = ? AND user_response IS NULL""",
        (response, tool_use_id),
    )
    await db.commit()


# ─── Pattern analysis ───────────────────────────────────────────────────

@dataclass
class ProposedRule:
    id: str                   # hash-based stable ID
    tool_name: str
    pattern_summary: str      # human-readable description
    suggested_pattern: str    # regex for the proposed rule
    suggested_action: str     # 'allow' or 'deny'
    sample_count: int
    approve_count: int
    deny_count: int
    consistency: float        # 0..1
    confidence: float         # 0..1
    workspace_id: Optional[str] = None


def _normalize_command(cmd: str) -> str:
    """Normalize a bash command for grouping.

    Strips variable parts (paths, arguments) to group similar commands.
    """
    # Extract the base command (first word or first two for git/npm etc.)
    parts = cmd.strip().split()
    if not parts:
        return ""
    base = parts[0]
    if base in ("git", "npm", "yarn", "pnpm", "pip", "pip3", "python3", "cargo", "go"):
        if len(parts) > 1:
            return f"{base} {parts[1]}"
    return base


def _normalize_path(path: str) -> str:
    """Normalize a file path for grouping.

    Keeps the last two directory components + extension pattern.
    """
    import os
    parts = path.split(os.sep)
    if len(parts) <= 2:
        return path
    # Keep last two dirs + filename pattern
    ext = os.path.splitext(parts[-1])[1]
    dir_part = os.sep.join(parts[-3:-1])
    return f"{dir_part}/*{ext}" if ext else f"{dir_part}/*"


_DISMISSED: set[str] = set()  # In-memory dismissed proposal IDs


async def analyze_patterns(
    db,
    workspace_id: Optional[str] = None,
    min_samples: int = 5,
    min_consistency: float = 0.9,
) -> list[ProposedRule]:
    """Analyze decision history and propose auto-rules.

    Groups decisions by tool + normalized pattern.  For groups with
    sufficient samples and consistent user behavior, proposes a rule.
    """
    # Query decisions that had user responses (ask decisions where user acted)
    where = "WHERE user_response IS NOT NULL AND decision = 'ask'"
    params = []
    if workspace_id:
        where += " AND workspace_id = ?"
        params.append(workspace_id)

    rows = await db.execute_fetchall(
        f"""SELECT tool_name, tool_input_summary, user_response
            FROM safety_decisions {where}
            ORDER BY created_at DESC LIMIT 5000""",
        params,
    )

    # Group by tool + normalized pattern
    groups: dict[str, dict] = {}
    for row in rows:
        tool = row["tool_name"]
        summary = row["tool_input_summary"] or ""
        response = row["user_response"]

        # Normalize for grouping
        if tool.lower() in ("bash", "execute"):
            key = f"{tool}:{_normalize_command(summary)}"
        else:
            key = f"{tool}:{_normalize_path(summary)}"

        if key not in groups:
            groups[key] = {
                "tool_name": tool,
                "summary": summary,
                "approved": 0,
                "denied": 0,
            }

        if response == "approved":
            groups[key]["approved"] += 1
        elif response == "denied":
            groups[key]["denied"] += 1

    # Generate proposals
    proposals = []
    for key, g in groups.items():
        total = g["approved"] + g["denied"]
        if total < min_samples:
            continue

        approve_rate = g["approved"] / total
        deny_rate = g["denied"] / total
        consistency = max(approve_rate, deny_rate)

        if consistency < min_consistency:
            continue

        # Stable ID from the group key
        proposal_id = hashlib.sha256(key.encode()).hexdigest()[:16]
        if proposal_id in _DISMISSED:
            continue

        # Build suggested pattern
        tool_name = g["tool_name"]
        summary = g["summary"]
        if tool_name.lower() in ("bash", "execute"):
            base_cmd = _normalize_command(summary)
            suggested_pattern = rf"^{re.escape(base_cmd)}\b" if base_cmd else summary
        else:
            norm_path = _normalize_path(summary)
            suggested_pattern = re.escape(norm_path).replace(r"\*", ".*")

        proposals.append(ProposedRule(
            id=proposal_id,
            tool_name=tool_name,
            pattern_summary=f"You {'approved' if approve_rate > deny_rate else 'denied'} "
                           f"`{key.split(':', 1)[1]}` {total} times "
                           f"({g['approved']} approved, {g['denied']} denied)",
            suggested_pattern=suggested_pattern,
            suggested_action="allow" if approve_rate >= min_consistency else "deny",
            sample_count=total,
            approve_count=g["approved"],
            deny_count=g["denied"],
            consistency=round(consistency, 3),
            confidence=round(min(1.0, total / (total + 5.0)), 3),
            workspace_id=workspace_id,
        ))

    # Sort by confidence desc
    proposals.sort(key=lambda p: -p.confidence)
    return proposals


def dismiss_proposal(proposal_id: str):
    """Mark a proposal as dismissed (won't appear again this session)."""
    _DISMISSED.add(proposal_id)


# Need re for _normalize and suggest_pattern
import re
