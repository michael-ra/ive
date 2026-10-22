"""Persisted provenance and profile-aware views of generated guideline text.

The guideline row remains the editable, authoritative document. Providers only
register exact text that they generated; this module contains no product text.
Inactive additions are omitted from views, never deleted from the stored row.
Unknown or user-modified text is not inferred to belong to an extension.
"""
from __future__ import annotations

import extension_host


SCHEMA = """
CREATE TABLE IF NOT EXISTS guideline_contributions (
    guideline_id TEXT NOT NULL REFERENCES guidelines(id) ON DELETE CASCADE,
    extension_id TEXT NOT NULL,
    contribution_key TEXT NOT NULL,
    content TEXT NOT NULL,
    PRIMARY KEY (guideline_id, extension_id, contribution_key)
);
"""


class GuidelineContributionConflict(ValueError):
    """An edit cannot safely retain an inactive generated addition in place."""


async def register_contribution(db, guideline_id, extension_id, key, content):
    """Record an installed owner's exact addition, including legacy backfills.

    Registration is deliberately conservative: a missing, changed or duplicated
    span cannot be attributed safely. Versioned keys retain previous provenance
    instead of silently replacing it when a provider changes its generated text.
    The caller controls the transaction together with its seed/upgrade.
    """
    if not all(isinstance(value, str) and value for value in
               (guideline_id, extension_id, key, content)):
        raise ValueError("Guideline contribution fields must be non-empty strings")
    if not extension_host.available(extension_id):
        raise extension_host.ExtensionUnavailable(extension_id)
    cur = await db.execute("SELECT content FROM guidelines WHERE id = ?", (guideline_id,))
    row = await cur.fetchone()
    if row is None or row["content"].count(content) != 1:
        return False
    await db.execute(
        """INSERT OR IGNORE INTO guideline_contributions
           (guideline_id, extension_id, contribution_key, content) VALUES (?, ?, ?, ?)""",
        (guideline_id, extension_id, key, content),
    )
    return True


async def _contributions(db, guideline_ids):
    if not guideline_ids:
        return {}
    placeholders = ",".join("?" for _ in guideline_ids)
    cur = await db.execute(
        f"""SELECT guideline_id, extension_id, content FROM guideline_contributions
            WHERE guideline_id IN ({placeholders})
            ORDER BY guideline_id, extension_id, contribution_key""",
        tuple(guideline_ids),
    )
    result = {}
    for row in await cur.fetchall():
        if not extension_host.available(row["extension_id"]):
            result.setdefault(row["guideline_id"], []).append(row["content"])
    return result


def _project(content, additions):
    """Return the visible text and exact hidden spans with visible offsets."""
    spans = []
    for addition in additions:
        # Never remove guessed ownership, altered user text or a second copy.
        if not addition or content.count(addition) != 1:
            continue
        start = content.index(addition)
        spans.append((start, start + len(addition), addition))
    spans.sort()
    parts, hidden, cursor, removed = [], [], 0, 0
    for start, end, addition in spans:
        if start < cursor:  # overlapping records cannot hide the same text twice
            continue
        parts.append(content[cursor:start])
        hidden.append((start - removed, addition))
        removed += end - start
        cursor = end
    parts.append(content[cursor:])
    return "".join(parts), hidden


async def project_guidelines(db, rows):
    """Project content-bearing rows for API, handoff and system-prompt reads."""
    result = [dict(row) for row in rows]
    additions = await _contributions(db, [row["id"] for row in result])
    for row in result:
        row["content"] = _project(row["content"], additions.get(row["id"], ()))[0]
    return result


def _map_boundary(before, after, offset):
    # Only unchanged context can locate an omitted addition in the edited view.
    # Prefer the following context at insertion boundaries. If the edit replaces
    # the anchor itself, reject it rather than moving or deleting retained text.
    for following in (True, False):
        for size in (128, 64, 32, 16):
            context = (before[offset:offset + size] if following
                       else before[max(0, offset - size):offset])
            if context and before.count(context) == 1 and after.count(context) == 1:
                start = after.index(context)
                return start if following else start + len(context)
    raise GuidelineContributionConflict(
        "This edit crosses retained extension guidance. Keep its surrounding text "
        "or enable the associated extension before editing this section. Your draft was not saved."
    )


async def preserve_inactive_contributions(db, guideline_id, content):
    """Merge an edited visible view without erasing hidden raw contributions.

    Ordinary edits on either side are mapped through unchanged context. An
    ambiguous replacement is rejected before any UPDATE; callers return 409 and
    keep the editor draft. With every owner enabled, editing is unchanged.
    """
    cur = await db.execute("SELECT content FROM guidelines WHERE id = ?", (guideline_id,))
    row = await cur.fetchone()
    if row is None:
        return content
    raw = row["content"]
    additions = await _contributions(db, [guideline_id])
    visible, hidden = _project(raw, additions.get(guideline_id, ()))
    if not hidden or content == raw:
        return content
    if content == visible:
        return raw
    if any(addition in content for _, addition in hidden):
        raise GuidelineContributionConflict(
            "Use the visible guideline content when editing while an extension is disabled. "
            "Your draft was not saved."
        )
    insertions = [(_map_boundary(visible, content, offset), addition)
                  for offset, addition in hidden]
    if any(left[0] > right[0] for left, right in zip(insertions, insertions[1:])):
        raise GuidelineContributionConflict(
            "This edit reorders retained extension guidance. Enable the associated "
            "extensions before moving these sections. Your draft was not saved."
        )
    for offset, addition in reversed(insertions):
        content = content[:offset] + addition + content[offset:]
    return content
