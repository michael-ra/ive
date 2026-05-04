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
import re
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


_BASE_WITH_SUBCMD = (
    "git", "npm", "yarn", "pnpm", "pip", "pip3", "python", "python3",
    "cargo", "go", "docker", "kubectl", "make", "brew",
)
_URL_FETCHERS = ("curl", "wget", "http", "https")

# Destructive command shapes — refuse to auto-propose `allow` rules for these
# even with high consistency. The user has historically approved them on a
# case-by-case basis, but a learned rule would silently allow every future
# variant (e.g. `git reset --hard origin/main` after they only ever approved
# `git reset HEAD file.txt`). Deny proposals are still allowed.
_DESTRUCTIVE_PREFIXES = (
    "git reset", "git push", "git checkout", "git clean", "git rebase",
    "git branch -D", "git branch -d",
    "rm", "rmdir", "mv",
    "kill", "pkill",
    "docker rm", "docker rmi", "docker system prune",
    "kubectl delete",
    "dd",
    "chmod", "chown",
    "shutdown", "reboot", "halt",
)


def _normalize_command(cmd: str) -> str:
    """Normalize a bash command for grouping.

    Returns "" when the command lacks enough context to learn an
    actionable pattern from — bare command names like `curl` or `grep`
    would otherwise auto-propose rules that match every invocation,
    which is too broad to be useful (and is what produced the
    `# / curl / git reset` "Learned Patterns" garbage in the UI).
    """
    parts = cmd.strip().split()
    if not parts:
        return ""
    base = parts[0]

    # Drop comment leaks and shell control characters — not real commands.
    if base.startswith("#") or base in (";", "&&", "||", "|", "&"):
        return ""

    if base in _BASE_WITH_SUBCMD:
        if len(parts) < 2:
            return ""
        sub = parts[1]
        # Keep a 3rd token when it's a flag — `git reset --hard` is meaningfully
        # different from `git reset HEAD` for what we'd auto-allow/deny.
        if len(parts) >= 3 and parts[2].startswith("-"):
            return f"{base} {sub} {parts[2]}"
        return f"{base} {sub}"

    # URL fetchers: key on host so different domains don't collapse together.
    if base in _URL_FETCHERS:
        for p in parts[1:]:
            if p.startswith("http://") or p.startswith("https://"):
                try:
                    from urllib.parse import urlparse
                    host = urlparse(p).hostname
                    if host:
                        return f"{base} {host}"
                except Exception:
                    pass
        return ""

    # Plain commands: require a 2nd token. Bare `grep` / `cat` / `ls` is
    # too broad — every invocation would match the same proposed rule.
    if len(parts) < 2:
        return ""
    second = parts[1]
    if second.startswith("/") or second.startswith("./") or second.startswith("~/"):
        import os
        second = os.path.basename(second) or second
    return f"{base} {second}"


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
    # Query 'ask' decisions — include both responded AND unresponded.
    # PostToolUse only fires when a user approves, so denials leave
    # user_response NULL.  Treat old unresponded 'ask' decisions as
    # implicit denials (the user saw the prompt and chose not to proceed).
    where = "WHERE decision = 'ask'"
    params = []
    if workspace_id:
        where += " AND workspace_id = ?"
        params.append(workspace_id)

    rows = await db.execute_fetchall(
        f"""SELECT tool_name, tool_input_summary, user_response,
                   created_at
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

        # Infer denial: 'ask' decisions with no user_response that are
        # older than 60s were almost certainly denied by the user.
        if response is None:
            try:
                from datetime import datetime, timezone, timedelta
                created = datetime.fromisoformat(row["created_at"].replace("Z", "+00:00"))
                if created.tzinfo is None:
                    created = created.replace(tzinfo=timezone.utc)
                if datetime.now(timezone.utc) - created < timedelta(seconds=60):
                    continue  # too recent — might still be pending approval
            except Exception:
                continue
            response = "denied"

        # Normalize for grouping. Skip rows whose normalized form is empty —
        # bare commands like `curl` or comment leaks would otherwise produce
        # auto-rules so broad they catch every future invocation.
        if tool.lower() in ("bash", "execute"):
            norm = _normalize_command(summary)
            if not norm:
                continue
            key = f"{tool}:{norm}"
        else:
            norm = _normalize_path(summary)
            if not norm:
                continue
            key = f"{tool}:{norm}"

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

        suggested_action = "allow" if approve_rate >= min_consistency else "deny"

        # Refuse to auto-propose `allow` for destructive command shapes —
        # the user might have approved each variant deliberately, but
        # baking a generic allow-rule could silently green-light a more
        # dangerous variant they'd otherwise want to review.
        if suggested_action == "allow":
            tail = key.split(":", 1)[1] if ":" in key else key
            if any(tail == p or tail.startswith(p + " ") for p in _DESTRUCTIVE_PREFIXES):
                continue

        # Stable ID from the group key
        proposal_id = hashlib.sha256(key.encode()).hexdigest()[:16]
        if proposal_id in _DISMISSED:
            continue

        # Build suggested pattern.
        tool_name = g["tool_name"]
        summary = g["summary"]
        if tool_name.lower() in ("bash", "execute"):
            base_cmd = _normalize_command(summary)
            if not base_cmd:
                continue
            tokens = base_cmd.split()
            # URL-fetcher keys are "curl <host>" — match the URL form, not the literal key.
            if tokens[0] in _URL_FETCHERS and len(tokens) >= 2:
                host_re = re.escape(tokens[1])
                suggested_pattern = rf"^{re.escape(tokens[0])}\b[^\n]*https?://{host_re}\b"
            else:
                suggested_pattern = rf"^{re.escape(base_cmd)}\b"
        else:
            norm_path = _normalize_path(summary)
            if not norm_path:
                continue
            suggested_pattern = re.escape(norm_path).replace(r"\*", ".*")

        proposals.append(ProposedRule(
            id=proposal_id,
            tool_name=tool_name,
            pattern_summary=f"You {'approved' if approve_rate > deny_rate else 'denied'} "
                           f"`{key.split(':', 1)[1]}` {total} times "
                           f"({g['approved']} approved, {g['denied']} denied)",
            suggested_pattern=suggested_pattern,
            suggested_action=suggested_action,
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
