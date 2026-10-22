"""Bounded, local project discovery. Reads project labels, never executes code."""
from __future__ import annotations

from collections import deque
import json
import os
from pathlib import Path
import re
import stat
import threading
import time
import unicodedata

SKIP = {
    "node_modules", "vendor", "venv", "env", "dist", "build", "target",
    "__pycache__", "library", "applications", "system", "pictures", "music",
    "movies", "photos", "caches", "cache", "coverage", "site-packages",
}
MARKERS = {".git", "package.json", "pyproject.toml", "requirements.txt", "Cargo.toml",
           "go.mod", "composer.json", "pom.xml", "index.html"}
GENERIC = {"app", "application", "website", "web", "site", "seite", "system", "tool", "frontend", "backend"}
STOP = set("""ich mochte moechte will wurde gerne bitte an am auf in im mit von vom der die das
    den dem des ein eine einen einem meiner meine mein meinem wir uns unser unsere und oder
    fur fuer zu zum zur jetzt weiter wieder etwas bisschen arbeiten bearbeite bearbeiten verbessern
    andern aendern machen offnen oeffnen starten suche such finde finden projekt workspace
    i want would like to work working on with the a an my our please open edit update improve
    find project workspace continue change can you help me of for and this that
    uberarbeiten ueberarbeiten aktualisieren bauen entwickeln programmieren bearbeiten rebuild modify editing""".split())


def normalize(value: str) -> str:
    value = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", value)
    value = value.casefold().replace("ä", "ae").replace("ö", "oe").replace("ü", "ue")
    value = unicodedata.normalize("NFKD", value)
    return " ".join(re.findall(r"[a-z0-9]+", "".join(c for c in value if not unicodedata.combining(c))))


def _read_label(path: Path) -> str:
    """Only small regular files, without following symlinks or opening FIFOs."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                return ""
            return stream.read(8192).decode("utf-8", errors="replace")
    except (OSError, ValueError):
        return ""


def _candidate(path: Path, entries: set[str]) -> dict:
    description = ""
    title = ""
    if "package.json" in entries:
        try:
            package = json.loads(_read_label(path / "package.json"))
            if isinstance(package, dict):
                title = str(package.get("name") or "")[:160]
                description = str(package.get("description") or "")[:240]
        except (ValueError, TypeError):
            pass
    readme = _read_label(path / "README.md") if "README.md" in entries else ""
    heading = next((line.lstrip("# ").strip() for line in readme.splitlines() if line.startswith("# ")), "")
    if not description:
        description = heading[:240]
    kind = "Git repository" if ".git" in entries else "Project folder"
    if "package.json" in entries:
        kind = "Node project"
    elif entries & {"pyproject.toml", "requirements.txt"}:
        kind = "Python project"
    elif "index.html" in entries:
        kind = "Website"
    return {"name": path.name, "path": str(path), "description": description, "kind": kind,
            "_name": normalize(path.name + " " + title),
            "_context": normalize(heading + " " + description + " " + readme[:2000]),
            "_parent": normalize(path.parent.name)}


class ProjectIndex:
    def __init__(self, home: Path, *, max_dirs=4000, max_depth=5, max_entries=60000, seconds=2.5):
        self.home = home.resolve()
        self.max_dirs, self.max_depth = max_dirs, max_depth
        self.max_entries, self.seconds = max_entries, seconds
        self._lock = threading.Lock()
        self._cached = None
        self._cached_at = 0.0

    def scan(self):
        pending = deque([(self.home, 0)])
        projects, visited = [], set()
        inspected_entries = 0
        partial = False
        deadline = time.monotonic() + self.seconds
        while pending:
            if len(visited) >= self.max_dirs or time.monotonic() >= deadline:
                partial = True
                break
            path, depth = pending.popleft()
            try:
                if path.is_symlink() or not path.resolve().is_relative_to(self.home):
                    continue
                canonical = path.resolve()
                if canonical in visited:
                    continue
                visited.add(canonical)
                names, children = set(), []
                with os.scandir(path) as listing:
                    for entry in listing:
                        inspected_entries += 1
                        if inspected_entries > self.max_entries or time.monotonic() >= deadline:
                            partial = True
                            break
                        if entry.is_symlink():
                            continue
                        names.add(entry.name)
                        low = entry.name.casefold()
                        if (depth < self.max_depth and not low.startswith(".") and low not in SKIP
                                and not low.endswith((".app", ".framework", ".bundle", ".photoslibrary"))
                                and entry.is_dir(follow_symlinks=False)):
                            children.append(Path(entry.path))
                if path != self.home and names & MARKERS:
                    projects.append(_candidate(path, names))
                    # A project root represents its source subfolders as one result.
                else:
                    children.sort(key=lambda p: (p.name.casefold() not in {"documents", "desktop", "projects", "code", "developer"}, p.name.casefold()))
                    pending.extend((child, depth + 1) for child in children)
                if partial:
                    break
            except (OSError, ValueError):
                continue
        return projects, partial

    def projects(self):
        with self._lock:
            if self._cached is None or time.monotonic() - self._cached_at > 30:
                self._cached = self.scan()
                self._cached_at = time.monotonic()
            return self._cached

    def search(self, query: str, workspaces=()):
        if not isinstance(query, str) or not 2 <= len(query.strip()) <= 240:
            raise ValueError("Describe the project using 2 to 240 characters.")
        terms = list(dict.fromkeys(term for term in normalize(query).split() if term not in STOP and len(term) > 1))
        if not terms:
            return {"matches": [], "partial": False, "needs_project_name": True}
        projects, partial = self.projects()
        by_path = {item["path"]: dict(item) for item in projects}
        for ws in workspaces:
            path = Path(ws["path"]).expanduser().resolve()
            if not path.is_dir():
                continue
            item = by_path.setdefault(str(path), {"name": ws["name"], "path": str(path),
                "description": "Already connected to IVE", "kind": "Workspace",
                "_name": normalize(path.name), "_context": "", "_parent": normalize(path.parent.name)})
            item["workspace_id"] = ws["id"]
            item["name"] = ws["name"]
            item["_name"] += " " + normalize(ws["name"])
        ranked = []
        for item in by_path.values():
            score, matched = 0, []
            specific_terms = set(terms) - GENERIC
            name_words = item["_name"].split()
            for term in terms:
                weight = (120 if term in name_words else 65 if any(word.startswith(term) for word in name_words)
                          else 35 if len(term) >= 4 and term in item["_name"] else 22 if term in item["_context"].split()
                          else 8 if term in item["_parent"] else 0)
                if weight:
                    if specific_terms and term in GENERIC:
                        weight *= .25
                    score += weight
                    matched.append(term)
            if score and (not specific_terms or specific_terms.intersection(matched)):
                # Match coverage beats incidental mentions of one generic word.
                score *= len(matched) / len(terms)
                score += 5 if item.get("workspace_id") else 0
                score += 4 if item["kind"] == "Git repository" else 0
                public = {key: value for key, value in item.items() if not key.startswith("_")}
                public["matched_terms"] = matched
                ranked.append((score, public))
        ranked.sort(key=lambda pair: (-pair[0], pair[1]["path"].casefold()))
        return {"matches": [item for _, item in ranked[:8]], "partial": partial, "needs_project_name": False}


_index = ProjectIndex(Path.home())


def search_projects(query: str, workspaces=()):
    return _index.search(query, workspaces)
