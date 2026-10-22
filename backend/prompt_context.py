"""Avoid duplicating project rules and mirrored notes in the launch prompt."""
from pathlib import Path


def project_instructions(cli, workspace_path):
    # Codex discovers AGENTS.md / AGENTS.override.md itself, including ancestry.
    if cli == "codex" or not workspace_path:
        return ""
    sections = []
    seen = set()
    start = Path(workspace_path)
    for directory in reversed([start, *list(start.parents)[:9]]):
        path = directory / "AGENTS.md"
        try:
            content = path.read_text().strip()
            if cli == "claude":
                # Mirrored AGENTS/CLAUDE files contain identical project notes.
                native = directory / "CLAUDE.md"
                if native.is_file() and native.read_text().strip() == content:
                    continue
            if content and content not in seen:
                sections.append(f"# From {path}\n{content}")
                seen.add(content)
        except (OSError, UnicodeError):
            continue
    return "# AGENTS.md\n" + "\n\n".join(sections) if sections else ""


def mirrored_entry_ids(config, entries):
    """Skip only exact bodies found in the effective provider's managed block."""
    from memory_sync import get_provider, _IVE_ENTRIES_START, _IVE_ENTRIES_END
    provider = get_provider(config.get("cli_type", "claude"))
    path = config.get("workspace_path")
    if not provider or not path:
        return set()
    raw = provider.read_memory_raw(path) or ""
    if _IVE_ENTRIES_START not in raw or _IVE_ENTRIES_END not in raw:
        return set()
    managed = raw.split(_IVE_ENTRIES_START, 1)[1].split(_IVE_ENTRIES_END, 1)[0]
    result = set()
    for entry in entries:
        if entry.get("workspace_id") != config.get("workspace_id"):
            continue
        block = [f"### {str(entry.get('name') or 'memory').strip()}", f"Type: {str(entry.get('type') or 'project').strip()}"]
        if entry.get("description"):
            block.append(f"Description: {entry['description'].strip()}")
        if entry.get("content"):
            block.extend(["", entry["content"].strip()])
        if "\n".join(block) + "\n" in managed:
            result.add(entry["id"])
    return result
