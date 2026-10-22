"""Sentiment monitoring — a corpus over time, not a search.

Research answers one question once: search, extract, synthesise, done. Monitoring
is the other shape — the same topic sampled repeatedly, every item kept with its
timestamp and author, each classified on its own, then aggregated across weeks.
"Top 10 results for a query" cannot answer "is this getting worse since June".

So this does not reuse the search providers. It uses the sources that expose a
time window (`created_at > T`) and returns *everything* new in it:

  - Hacker News via the Algolia index (no key) — comments included, and the
    comments are the point: practitioner opinion that never reaches a blog post.
  - GitHub issues and PRs (token optional but strongly advised) — where friction
    with a tool gets written down by the people hitting it.

The local SQLite corpus retains individual observations and their time axis so
reports can aggregate repeated samples. Optional output adapters can consume
the resulting report without changing this source corpus.
"""

from __future__ import annotations

import asyncio
import logging
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import aiohttp

from .search import _strip_html

logger = logging.getLogger(__name__)

SENTIMENTS = ("positive", "neutral", "negative", "mixed")
CLASSIFY_BATCH = 12          # items per LLM call — keeps prompts well inside context
FETCH_PAGE_LIMIT = 5         # pages per source per run; bounded so a wide window
                             # cannot silently turn into thousands of requests


@dataclass
class Item:
    """One thing somebody wrote, at a point in time."""

    source: str
    external_id: str          # stable per source — the dedup key
    url: str
    author: str
    created_at: int           # unix seconds
    title: str
    text: str

    def digest(self, limit: int = 400) -> str:
        body = self.text.strip() or self.title
        return body[:limit]


# ── Sources ────────────────────────────────────────────────────────


class MonitorSource:
    name = "base"

    def available(self) -> bool:
        return True

    async def fetch_since(self, query: str, since: int, limit: int) -> list[Item]:
        raise NotImplementedError

    # Set when `limit` cut the fetch short. Both sources return newest-first, so
    # a truncated fetch silently drops the OLDER end of the window — which reads
    # as "nothing happened back then" instead of "we stopped looking".
    truncated: bool = False


class HackerNewsMonitor(MonitorSource):
    """Stories and comments, newest first, from the Algolia HN index."""

    name = "hackernews"
    PAGE_SIZE = 100

    async def fetch_since(self, query: str, since: int, limit: int) -> list[Item]:
        items: list[Item] = []
        async with aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=30)
        ) as session:
            for page in range(FETCH_PAGE_LIMIT):
                params = {
                    "query": query,
                    "tags": "(story,comment)",
                    "numericFilters": f"created_at_i>{since}",
                    "hitsPerPage": str(min(self.PAGE_SIZE, limit - len(items))),
                    "page": str(page),
                }
                try:
                    async with session.get(
                        "https://hn.algolia.com/api/v1/search_by_date", params=params
                    ) as resp:
                        if resp.status != 200:
                            logger.warning("HN monitor: HTTP %s", resp.status)
                            break
                        data = await resp.json()
                except Exception as e:
                    logger.warning("HN monitor failed: %s", e)
                    break

                hits = data.get("hits", [])
                for hit in hits:
                    oid = str(hit.get("objectID", ""))
                    if not oid:
                        continue
                    is_story = bool(hit.get("title"))
                    items.append(Item(
                        source=self.name,
                        external_id=oid,
                        url=f"https://news.ycombinator.com/item?id={oid}",
                        author=hit.get("author") or "",
                        created_at=int(hit.get("created_at_i") or 0),
                        title=hit.get("title") or hit.get("story_title") or "",
                        text=_strip_html(
                            hit.get("story_text") if is_story else hit.get("comment_text", "")
                        ),
                    ))
                if len(items) >= limit or page + 1 >= data.get("nbPages", 0):
                    break
        self.truncated = len(items) >= limit and data.get("nbHits", 0) > limit
        return items[:limit]


class GitHubIssuesMonitor(MonitorSource):
    """Issues and PRs opened in the window. Unauthenticated is heavily throttled."""

    name = "github_issues"
    PAGE_SIZE = 50

    def __init__(self, token: str | None = None):
        self.token = token

    async def fetch_since(self, query: str, since: int, limit: int) -> list[Item]:
        day = datetime.fromtimestamp(since, timezone.utc).strftime("%Y-%m-%d")
        headers = {"Accept": "application/vnd.github.v3+json"}
        if self.token:
            headers["Authorization"] = f"token {self.token}"

        items: list[Item] = []
        async with aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=30)
        ) as session:
            for page in range(1, FETCH_PAGE_LIMIT + 1):
                params = {
                    "q": f"{query} created:>{day}",
                    "per_page": str(min(self.PAGE_SIZE, limit - len(items))),
                    "page": str(page),
                    "sort": "created",
                    "order": "desc",
                }
                try:
                    async with session.get(
                        "https://api.github.com/search/issues",
                        params=params, headers=headers,
                    ) as resp:
                        if resp.status in (403, 429):
                            logger.info(
                                "GitHub monitor rate-limited after %d items — "
                                "set GITHUB_TOKEN to raise the ceiling", len(items)
                            )
                            break
                        if resp.status != 200:
                            logger.warning("GitHub monitor: HTTP %s", resp.status)
                            break
                        data = await resp.json()
                except Exception as e:
                    logger.warning("GitHub monitor failed: %s", e)
                    break

                hits = data.get("items", [])
                if not hits:
                    break
                for r in hits:
                    created = r.get("created_at") or ""
                    try:
                        ts = int(datetime.fromisoformat(
                            created.replace("Z", "+00:00")).timestamp())
                    except ValueError:
                        ts = 0
                    items.append(Item(
                        source=self.name,
                        external_id=str(r.get("id", "")),
                        url=r.get("html_url", ""),
                        author=(r.get("user") or {}).get("login", ""),
                        created_at=ts,
                        title=r.get("title", ""),
                        text=(r.get("body") or "").strip(),
                    ))
                if len(items) >= limit:
                    self.truncated = data.get("total_count", 0) > limit
                    break
                # Rate-limit courtesy: unauthenticated search allows ~10/min.
                await asyncio.sleep(0 if self.token else 6)
        return items[:limit]


def build_sources(config) -> list[MonitorSource]:
    sources: list[MonitorSource] = [
        HackerNewsMonitor(),
        GitHubIssuesMonitor(token=getattr(config, "github_token", None)),
    ]
    return [s for s in sources if s.available()]


# ── Corpus ─────────────────────────────────────────────────────────

SCHEMA = """
CREATE TABLE IF NOT EXISTS monitor_items (
    id           INTEGER PRIMARY KEY,
    topic        TEXT NOT NULL,
    source       TEXT NOT NULL,
    external_id  TEXT NOT NULL,
    url          TEXT,
    author       TEXT,
    created_at   INTEGER NOT NULL,
    title        TEXT,
    text         TEXT,
    sentiment    TEXT,
    theme        TEXT,
    relevant     INTEGER,
    classified_at TEXT,
    fetched_at   TEXT NOT NULL,
    UNIQUE(topic, source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_monitor_topic_time
    ON monitor_items(topic, created_at);
CREATE TABLE IF NOT EXISTS monitor_runs (
    topic       TEXT NOT NULL,
    source      TEXT NOT NULL,
    last_run_at TEXT NOT NULL,
    last_seen   INTEGER NOT NULL,
    PRIMARY KEY (topic, source)
);
"""


class Corpus:
    """SQLite store for monitored items. Append-only apart from classification."""

    def __init__(self, path: str | Path):
        self.path = Path(path).expanduser()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(self.path))
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def add(self, topic: str, items: list[Item]) -> int:
        """Insert new items, ignoring ones already stored. Returns the new count."""
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        before = self.conn.total_changes
        self.conn.executemany(
            "INSERT OR IGNORE INTO monitor_items "
            "(topic, source, external_id, url, author, created_at, title, text, fetched_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            [(topic, i.source, i.external_id, i.url, i.author,
              i.created_at, i.title, i.text, now) for i in items],
        )
        self.conn.commit()
        return self.conn.total_changes - before

    def mark_run(self, topic: str, source: str, last_seen: int):
        self.conn.execute(
            "INSERT INTO monitor_runs (topic, source, last_run_at, last_seen) "
            "VALUES (?,?,?,?) ON CONFLICT(topic, source) DO UPDATE SET "
            "last_run_at=excluded.last_run_at, last_seen=max(last_seen, excluded.last_seen)",
            (topic, source, datetime.now(timezone.utc).isoformat(timespec="seconds"),
             last_seen),
        )
        self.conn.commit()

    def last_seen(self, topic: str, source: str) -> int | None:
        row = self.conn.execute(
            "SELECT last_seen FROM monitor_runs WHERE topic=? AND source=?",
            (topic, source),
        ).fetchone()
        return row["last_seen"] if row else None

    def known_themes(self, topic: str, limit: int = 30) -> list[str]:
        """Themes already used for this topic, most frequent first.

        Fed back into the prompt so the model reuses existing wording instead of
        minting "CI regression" next to "CI performance regression" — matching
        after the fact would be guesswork, offering candidates is not.
        """
        rows = self.conn.execute(
            "SELECT theme, COUNT(*) n FROM monitor_items "
            "WHERE topic=? AND theme IS NOT NULL AND theme != '' "
            "GROUP BY theme ORDER BY n DESC LIMIT ?",
            (topic, limit),
        ).fetchall()
        return [r["theme"] for r in rows]

    def unclassified(self, topic: str, limit: int = 500) -> list[sqlite3.Row]:
        return self.conn.execute(
            "SELECT * FROM monitor_items WHERE topic=? AND classified_at IS NULL "
            "ORDER BY created_at DESC LIMIT ?",
            (topic, limit),
        ).fetchall()

    def save_classification(self, rows: list[dict]):
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        self.conn.executemany(
            "UPDATE monitor_items SET sentiment=?, theme=?, relevant=?, classified_at=? "
            "WHERE id=?",
            [(r["sentiment"], r["theme"], int(r["relevant"]), now, r["id"]) for r in rows],
        )
        self.conn.commit()

    def stats(self, topic: str) -> dict:
        total = self.conn.execute(
            "SELECT COUNT(*) c FROM monitor_items WHERE topic=?", (topic,)
        ).fetchone()["c"]
        done = self.conn.execute(
            "SELECT COUNT(*) c FROM monitor_items WHERE topic=? AND classified_at IS NOT NULL",
            (topic,),
        ).fetchone()["c"]
        return {"total": total, "classified": done}

    def close(self):
        self.conn.close()


# ── Classification ─────────────────────────────────────────────────

CLASSIFY_PROMPT = """\
Classify each item below for sentiment toward the subject: {topic}

Judge the author's stance on {topic} specifically — not their mood in general,
and not the sentiment of some other tool they happen to mention.

{known}Items:
{items}

Return ONLY a JSON object:
{{"items": [{{"n": 0, "relevant": true, "sentiment": "negative", "theme": "short noun phrase"}}]}}

Rules:
- "relevant": false when the item is not actually about {topic}. Everything else
  about that item is then ignored, so do not guess a sentiment to fill the slot.
- "sentiment": one of positive, neutral, negative, mixed
- "theme": 2-5 words naming the concrete subject (e.g. "cold start latency",
  "pricing change", "docs quality"). If one of the existing themes above fits,
  reuse it VERBATIM — these get counted, and near-duplicate wording splits the
  count. Only invent a new theme when none fits.
- One entry per item, same "n" as given."""


def _parse_classification(data, batch: list[sqlite3.Row]) -> list[dict]:
    """Map the model's answer back onto rows, tolerating the usual drift."""
    entries = data.get("items", data) if isinstance(data, dict) else data
    if not isinstance(entries, list):
        raise ValueError(f"items is {type(entries).__name__}, not a list")

    out = []
    for entry in entries:
        if isinstance(entry, (list, tuple)) and entry:
            # Same key/value flattening the scoring step produces.
            if len(entry) % 2 == 0 and all(isinstance(k, str) for k in entry[::2]):
                entry = dict(zip(entry[::2], entry[1::2]))
            else:
                continue
        if not isinstance(entry, dict):
            continue
        try:
            n = int(entry.get("n"))
        except (TypeError, ValueError):
            continue
        if not 0 <= n < len(batch):
            continue
        sentiment = str(entry.get("sentiment", "")).strip().lower()
        if sentiment not in SENTIMENTS:
            sentiment = "neutral"
        relevant = entry.get("relevant", True)
        if isinstance(relevant, str):
            relevant = relevant.strip().lower() in ("true", "yes", "1")
        out.append({
            "id": batch[n]["id"],
            "sentiment": sentiment,
            "theme": str(entry.get("theme", "")).strip()[:60],
            "relevant": bool(relevant),
        })
    return out


async def classify(llm, topic: str, corpus: Corpus, limit: int, progress=print) -> int:
    """Classify stored items that have no verdict yet. Returns how many got one."""
    pending = corpus.unclassified(topic, limit)
    if not pending:
        return 0

    done = 0
    for start in range(0, len(pending), CLASSIFY_BATCH):
        batch = pending[start : start + CLASSIFY_BATCH]
        listing = "\n".join(
            f"[{n}] ({row['source']}, {row['author'] or 'anon'}) "
            f"{(row['title'] or '')[:80]}\n    {(row['text'] or '')[:400]}"
            for n, row in enumerate(batch)
        )
        known = corpus.known_themes(topic)
        known_block = (
            "Existing themes for this topic (reuse verbatim where they fit):\n"
            + "\n".join(f"  - {t}" for t in known) + "\n\n"
        ) if known else ""
        try:
            data = await llm.generate_json(
                CLASSIFY_PROMPT.format(topic=topic, items=listing, known=known_block),
                task_hint="classify",
            )
            rows = _parse_classification(data, batch)
        except Exception as e:
            logger.warning("Classification batch failed: %s", e)
            continue
        if rows:
            corpus.save_classification(rows)
            done += len(rows)
        progress(f"    classified {done}/{len(pending)}")
    return done


# ── Aggregation ────────────────────────────────────────────────────


def report(corpus: Corpus, topic: str, bucket: str = "week") -> dict:
    """Sentiment over time plus the themes driving it."""
    fmt = {"day": "%Y-%m-%d", "week": "%Y-W%W", "month": "%Y-%m"}.get(bucket, "%Y-W%W")

    rows = corpus.conn.execute(
        "SELECT strftime(?, created_at, 'unixepoch') AS bucket, sentiment, "
        "COUNT(*) AS n FROM monitor_items "
        "WHERE topic=? AND classified_at IS NOT NULL AND relevant=1 "
        "GROUP BY bucket, sentiment ORDER BY bucket",
        (fmt, topic),
    ).fetchall()

    timeline: dict[str, dict] = {}
    for r in rows:
        b = timeline.setdefault(r["bucket"], {s: 0 for s in SENTIMENTS})
        b[r["sentiment"]] = r["n"]

    themes = corpus.conn.execute(
        "SELECT theme, sentiment, COUNT(*) AS n FROM monitor_items "
        "WHERE topic=? AND classified_at IS NOT NULL AND relevant=1 AND theme != '' "
        "GROUP BY theme, sentiment ORDER BY n DESC LIMIT 40",
        (topic,),
    ).fetchall()

    by_theme: dict[str, dict] = {}
    for r in themes:
        t = by_theme.setdefault(r["theme"], {"total": 0, **{s: 0 for s in SENTIMENTS}})
        t[r["sentiment"]] = r["n"]
        t["total"] += r["n"]

    dropped = corpus.conn.execute(
        "SELECT COUNT(*) c FROM monitor_items "
        "WHERE topic=? AND classified_at IS NOT NULL AND relevant=0",
        (topic,),
    ).fetchone()["c"]

    return {
        "topic": topic,
        "bucket": bucket,
        "timeline": timeline,
        "themes": dict(sorted(by_theme.items(), key=lambda kv: -kv[1]["total"])),
        "off_topic_dropped": dropped,
        **corpus.stats(topic),
    }


def render(rep: dict) -> str:
    """The report as text — sparkline-ish, readable in a terminal."""
    lines = [f"Sentiment: {rep['topic']}", "=" * 50]
    lines.append(
        f"{rep['classified']}/{rep['total']} items classified"
        + (f", {rep['off_topic_dropped']} judged off-topic" if rep["off_topic_dropped"] else "")
    )

    if not rep["timeline"]:
        lines.append("\nNothing classified as relevant yet.")
        return "\n".join(lines)

    lines.append(f"\nBy {rep['bucket']}:")
    lines.append(f"  {'':<10} {'pos':>5} {'neu':>5} {'neg':>5} {'mix':>5}   balance")
    for bucket, counts in rep["timeline"].items():
        pos, neg = counts["positive"], counts["negative"]
        total = sum(counts.values()) or 1
        # Balance: share positive minus share negative, as a coarse bar.
        score = (pos - neg) / total
        filled = int(abs(score) * 10)
        bar = ("+" * filled if score >= 0 else "-" * filled) or "."
        lines.append(
            f"  {bucket:<10} {pos:>5} {counts['neutral']:>5} "
            f"{neg:>5} {counts['mixed']:>5}   {bar}"
        )

    if rep["themes"]:
        lines.append("\nThemes:")
        for theme, c in list(rep["themes"].items())[:12]:
            lines.append(
                f"  {c['total']:>3}x  {theme:<34} "
                f"(+{c['positive']} / -{c['negative']})"
            )
    return "\n".join(lines)


# ── Orchestration ──────────────────────────────────────────────────


def parse_window(spec: str) -> int:
    """'7d' / '12h' / '4w' → unix timestamp that far back."""
    m = re.fullmatch(r"(\d+)\s*([hdwm])", (spec or "").strip().lower())
    if not m:
        raise ValueError(f"Bad window '{spec}' — use e.g. 24h, 7d, 4w, 3m")
    n, unit = int(m.group(1)), m.group(2)
    delta = {
        "h": timedelta(hours=n), "d": timedelta(days=n),
        "w": timedelta(weeks=n), "m": timedelta(days=30 * n),
    }[unit]
    return int((datetime.now(timezone.utc) - delta).timestamp())


async def collect(
    config,
    topic: str,
    window: str = "7d",
    db_path: str | None = None,
    limit_per_source: int = 200,
    progress=print,
) -> dict:
    """Fetch everything new about `topic` in the window into the corpus."""
    corpus = Corpus(db_path or "monitor.db")
    since = parse_window(window)
    counts: dict[str, int] = {}

    truncated: list[str] = []
    for source in build_sources(config):
        # Resume from the last run when it is more recent than the window, so a
        # daily job does not refetch a week each time.
        seen = corpus.last_seen(topic, source.name)
        start = max(since, seen) if seen else since
        progress(f"  {source.name}: since {datetime.fromtimestamp(start, timezone.utc):%Y-%m-%d %H:%M}")

        items = await source.fetch_since(topic, start, limit_per_source)
        new = corpus.add(topic, items)
        counts[source.name] = new
        note = ""
        if getattr(source, "truncated", False):
            truncated.append(source.name)
            # Say it out loud: the oldest part of the window was never fetched.
            note = f" — hit the {limit_per_source} cap, older items NOT fetched"
            # And do NOT advance the checkpoint. Sources return newest-first, so
            # a truncated fetch leaves a hole at the OLD end of the window;
            # checkpointing the newest timestamp would skip that hole forever
            # and the gap would never be visible again.
        elif items:
            corpus.mark_run(topic, source.name, max(i.created_at for i in items))
        progress(f"    {len(items)} fetched, {new} new{note}")

    if truncated:
        progress(
            f"  note: {', '.join(truncated)} truncated at --limit; the window's "
            "older end is missing. Raise --limit or narrow --since."
        )
    return {"counts": counts, "corpus": corpus, "truncated": truncated}
