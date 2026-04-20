"""Session Advisor — smart guideline recommendation via semantic analysis.

Uses Commander's existing embedding infrastructure (BAAI/bge-small-en-v1.5)
for two purposes:

1. **Semantic pole scoring**: embed user messages against cached anchor pairs
   (satisfaction, certainty, engagement, correction) to score session quality
   without keyword matching or sentiment word lists.

2. **Guideline recommendation**: embed all guidelines as entity_type='guideline',
   maintain a per-session intent buffer that accumulates context from user
   messages and tool signals, and recommend guidelines based on:
   - Semantic similarity to past session digests (→ which guidelines they used)
   - Direct semantic match to guideline content/when_to_use
   - Historical guideline effectiveness (quality_delta when guideline attached)

Trigger philosophy: continuous intent accumulation — NOT a one-shot "first
message" trigger. The IntentBuffer grows with each user message and tool event,
re-evaluates recommendations when the accumulated context changes meaningfully.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import uuid
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)

# ── Semantic Pole Anchors ──────────────────────────────────────────────────
# Each dimension has a positive and negative anchor phrase. We embed these
# once at startup and cache the vectors. Per-message scoring computes cosine
# similarity to each pole and normalizes to 0..1.

SEMANTIC_POLES: dict[str, dict[str, str]] = {
    "satisfaction": {
        "positive": "great, exactly what I wanted, perfect, well done, nice work, that looks correct",
        "negative": "no that's wrong, undo that, completely broken, this is terrible, bad output",
    },
    "certainty": {
        "positive": "yes do it, go ahead, confirmed, approved, exactly right, proceed",
        "negative": "hmm I'm not sure, wait, let me think, hold on, maybe not, I need to reconsider",
    },
    "engagement": {
        "positive": "keep going, add more, let's also do, expand on that, and another thing, next step",
        "negative": "just stop, forget it, never mind, cancel that, I give up, enough",
    },
    "correction": {
        "positive": "perfect approach, good solution, that's the right way, well thought out, smart choice",
        "negative": "wrong approach, start over, revert this, completely off, no no no, that's not what I asked",
    },
}

# Weights for aggregating dimension scores into a single session quality score
DIMENSION_WEIGHTS = {
    "satisfaction": 0.35,
    "correction": 0.30,
    "engagement": 0.20,
    "certainty": 0.15,
}

# Minimum message length to score (very short messages are too ambiguous)
MIN_MESSAGE_LENGTH = 5

# How many user messages to keep in the intent buffer (sliding window)
INTENT_BUFFER_MAX_MESSAGES = 10

# How many tool signals to keep
INTENT_BUFFER_MAX_TOOL_SIGNALS = 8

# Minimum number of messages (or purpose set) before recommending
RECOMMEND_THRESHOLD_MESSAGES = 3

# Auto-attach confidence threshold
AUTO_ATTACH_THRESHOLD = 0.80

# Dynamic min_score: stricter with fewer messages, relaxes as context accumulates
MIN_SCORE_EARLY = 0.70   # < 3 messages — only strong matches
MIN_SCORE_NORMAL = 0.58  # >= 3 messages — tuned to reject unrelated queries (F1=94%)

# Cross-encoder raw score floor: only use reranker when the best match
# has a meaningful relevance signal (ms-marco logit > this value).
# Prevents false positives on casual/unrelated messages.
RERANK_RAW_FLOOR = -9.5

# Generality penalty: dampens guidelines that match too many distinct sessions.
# Factor = 1 / (1 + GENERALITY_DECAY * ln(unique_session_count)).
# At 10 sessions: ~0.52, at 20: ~0.45, at 50: ~0.39.
GENERALITY_DECAY = 0.4

# In-memory cache: guideline_id → count of unique sessions recommended to.
# Loaded from DB on first access, updated on each recommendation push.
_generality_counts: dict[str, int] = {}
_generality_loaded = False


async def _ensure_generality_counts():
    """Load recommendation counts from DB on first use."""
    global _generality_loaded
    if _generality_loaded:
        return
    _generality_loaded = True
    try:
        from db import get_db
        db = await get_db()
        try:
            cur = await db.execute(
                "SELECT guideline_id, COUNT(*) as cnt FROM guideline_rec_history GROUP BY guideline_id"
            )
            for row in await cur.fetchall():
                _generality_counts[row["guideline_id"]] = row["cnt"]
        finally:
            await db.close()
    except Exception:
        logger.debug("Could not load generality counts (table may not exist yet)")


def _generality_penalty(guideline_id: str) -> float:
    """Return a multiplier (0..1] penalizing guidelines recommended to many sessions."""
    count = _generality_counts.get(guideline_id, 0)
    if count <= 1:
        return 1.0
    return 1.0 / (1.0 + GENERALITY_DECAY * math.log(count))


async def _record_recommendation(guideline_id: str, session_id: str):
    """Persist a recommendation event and update the in-memory count."""
    try:
        from db import get_db
        db = await get_db()
        try:
            await db.execute(
                "INSERT OR IGNORE INTO guideline_rec_history (guideline_id, session_id) VALUES (?, ?)",
                (guideline_id, session_id),
            )
            await db.commit()
        finally:
            await db.close()
    except Exception:
        logger.debug("Could not persist rec history (table may not exist yet)")

    # Update in-memory count
    prev = _generality_counts.get(guideline_id, 0)
    _generality_counts[guideline_id] = prev + 1


_anchor_cache: dict[str, dict[str, list[float]]] = {}
_anchor_lock = asyncio.Lock()


async def _ensure_anchors() -> bool:
    """Pre-compute anchor embeddings on first use. Returns False if unavailable."""
    if _anchor_cache:
        return True

    async with _anchor_lock:
        if _anchor_cache:
            return True

        try:
            from embedder import embed_batch
        except ImportError:
            logger.warning("embedder not available — session advisor disabled")
            return False

        # Collect all anchor texts for a single batch embed call
        texts = []
        keys = []  # (dimension, pole)
        for dim, poles in SEMANTIC_POLES.items():
            for pole, text in poles.items():
                texts.append(text)
                keys.append((dim, pole))

        vectors = await embed_batch(texts)
        if vectors is None:
            logger.warning("Embedding model unavailable — session advisor disabled")
            return False

        for (dim, pole), vec in zip(keys, vectors):
            if dim not in _anchor_cache:
                _anchor_cache[dim] = {}
            _anchor_cache[dim][pole] = vec

        logger.info("Session advisor: %d anchor embeddings cached", len(texts))
        return True


# ── Per-message Scoring ────────────────────────────────────────────────────

async def score_message(text: str) -> dict[str, float] | None:
    """Score a single user message against semantic poles.

    Returns {"satisfaction": 0.72, "certainty": 0.81, ...} or None.
    """
    if len(text.strip()) < MIN_MESSAGE_LENGTH:
        return None

    if not await _ensure_anchors():
        return None

    from embedder import embed, _cosine

    msg_vec = await embed(text)
    if msg_vec is None:
        return None

    scores = {}
    for dim, poles in _anchor_cache.items():
        sim_pos = _cosine(msg_vec, poles["positive"])
        sim_neg = _cosine(msg_vec, poles["negative"])
        # Normalize to 0..1: higher = more positive
        scores[dim] = (sim_pos - sim_neg + 1.0) / 2.0

    return scores


async def score_message_batch(texts: list[str]) -> list[dict[str, float] | None]:
    """Score multiple messages efficiently (single embed_batch call)."""
    if not await _ensure_anchors():
        return [None] * len(texts)

    from embedder import embed_batch, _cosine

    # Filter out too-short messages but keep index mapping
    valid_indices = [i for i, t in enumerate(texts) if len(t.strip()) >= MIN_MESSAGE_LENGTH]
    valid_texts = [texts[i] for i in valid_indices]

    if not valid_texts:
        return [None] * len(texts)

    vectors = await embed_batch(valid_texts)
    if vectors is None:
        return [None] * len(texts)

    results: list[dict[str, float] | None] = [None] * len(texts)
    for idx, vec in zip(valid_indices, vectors):
        scores = {}
        for dim, poles in _anchor_cache.items():
            sim_pos = _cosine(vec, poles["positive"])
            sim_neg = _cosine(vec, poles["negative"])
            scores[dim] = (sim_pos - sim_neg + 1.0) / 2.0
        results[idx] = scores

    return results


# ── Intent Buffer (per-session, in-memory) ─────────────────────────────────

@dataclass
class IntentBuffer:
    """Accumulates session context for guideline recommendation."""
    session_id: str
    workspace_id: str | None = None
    purpose: str | None = None
    user_messages: list[str] = field(default_factory=list)
    tool_signals: list[str] = field(default_factory=list)
    _last_dense: str | None = field(default=None, repr=False)
    _last_recommendation_hash: str = field(default="", repr=False)
    _dismissed: set[str] = field(default_factory=set, repr=False)
    _rec_in_flight: bool = field(default=False, repr=False)

    def dense_text(self) -> str:
        """Build dense text representation of accumulated intent."""
        parts = []
        if self.purpose:
            parts.append(f"Purpose: {self.purpose}")
        # Use recent messages (last N)
        for msg in self.user_messages[-INTENT_BUFFER_MAX_MESSAGES:]:
            parts.append(msg[:200])
        for sig in self.tool_signals[-INTENT_BUFFER_MAX_TOOL_SIGNALS:]:
            parts.append(f"tool: {sig}")
        dense = " | ".join(parts)
        return dense[:500] if dense else ""

    def should_recommend(self) -> bool:
        """Check if we have enough context and it's changed since last push."""
        # Need either a purpose or enough messages
        has_context = bool(self.purpose) or len(self.user_messages) >= RECOMMEND_THRESHOLD_MESSAGES
        if not has_context:
            return False
        # Only recommend if dense text changed
        current = self.dense_text()
        if current == self._last_dense:
            return False
        return True

    def mark_recommended(self):
        """Mark the current dense text as already recommended."""
        self._last_dense = self.dense_text()


# Global intent buffer registry
_intent_buffers: dict[str, IntentBuffer] = {}


def _get_or_create_buffer(session_id: str, workspace_id: str | None = None) -> IntentBuffer:
    """Get or create an intent buffer for a session."""
    if session_id not in _intent_buffers:
        _intent_buffers[session_id] = IntentBuffer(
            session_id=session_id,
            workspace_id=workspace_id,
        )
    buf = _intent_buffers[session_id]
    if workspace_id and not buf.workspace_id:
        buf.workspace_id = workspace_id
    return buf


async def update_intent(
    session_id: str,
    text: str,
    source: str = "user",
    workspace_id: str | None = None,
    broadcast_fn=None,
):
    """Feed new context into a session's intent buffer.

    Args:
        session_id: The session to update
        text: The content (user message, tool signal, or purpose)
        source: "user" | "tool" | "purpose"
        workspace_id: Workspace ID for scoping recommendations
        broadcast_fn: async fn(dict) to push WS events (server.broadcast)
    """
    buf = _get_or_create_buffer(session_id, workspace_id)

    if source == "purpose":
        buf.purpose = text
    elif source == "tool":
        # Deduplicate consecutive identical tool signals
        if not buf.tool_signals or buf.tool_signals[-1] != text:
            buf.tool_signals.append(text)
            if len(buf.tool_signals) > INTENT_BUFFER_MAX_TOOL_SIGNALS + 5:
                buf.tool_signals = buf.tool_signals[-INTENT_BUFFER_MAX_TOOL_SIGNALS:]
    else:  # "user"
        buf.user_messages.append(text)
        if len(buf.user_messages) > INTENT_BUFFER_MAX_MESSAGES + 5:
            buf.user_messages = buf.user_messages[-INTENT_BUFFER_MAX_MESSAGES:]

    # Check if we should push recommendations (skip if one is already in flight
    # to avoid duplicate notifications from concurrent async tasks).
    if buf.should_recommend() and not buf._rec_in_flight:
        buf._rec_in_flight = True
        asyncio.create_task(_maybe_push_recommendations(session_id, broadcast_fn))


async def get_intent_text(session_id: str) -> str | None:
    """Get the current dense text for a session's accumulated intent."""
    buf = _intent_buffers.get(session_id)
    if not buf:
        return None
    dense = buf.dense_text()
    return dense if dense else None


async def dismiss_recommendation(session_id: str, guideline_id: str):
    """Mark a guideline as dismissed for this session (won't be re-recommended)."""
    buf = _get_or_create_buffer(session_id)
    buf._dismissed.add(guideline_id)


def clear_intent(session_id: str):
    """Cleanup intent buffer on session exit."""
    _intent_buffers.pop(session_id, None)


# ── Recommendation Engine ──────────────────────────────────────────────────

async def recommend_guidelines(
    intent_text: str,
    workspace_id: str | None = None,
    session_id: str | None = None,
    excluded: set[str] | None = None,
    limit: int = 5,
    min_score: float = 0.45,
) -> list[dict]:
    """Recommend guidelines based on accumulated intent.

    Algorithm:
    1. Find similar past sessions (digest embeddings) → get their guideline_ids
    2. Find semantically similar guidelines (guideline embeddings)
    3. Cross-reference with guideline_effectiveness scores
    4. Rank by composite: similarity(0.4) + effectiveness(0.4) + confidence(0.2)
    5. Filter out excluded IDs (already attached + dismissed)
    """
    if not intent_text:
        return []

    try:
        from embedder import search_similar
    except ImportError:
        return []

    await _ensure_generality_counts()

    excluded = excluded or set()

    # Channel 1: Find similar past sessions → get their guidelines
    history_guidelines: dict[str, dict] = {}  # guideline_id → {score, session_count}
    similar_sessions = await search_similar(
        intent_text, entity_type="digest",
        workspace_id=workspace_id, limit=10, min_score=0.45,
    )

    if similar_sessions:
        from db import get_db
        db = await get_db()
        try:
            for sess in similar_sessions:
                # Look up what guidelines were attached to this session
                cur = await db.execute(
                    """SELECT sq.guideline_ids FROM session_quality sq
                       WHERE sq.session_id = ?""",
                    (sess["entity_id"],),
                )
                row = await cur.fetchone()
                if row and row["guideline_ids"]:
                    try:
                        gids = json.loads(row["guideline_ids"])
                    except (json.JSONDecodeError, TypeError):
                        gids = []
                    for gid in gids:
                        if gid not in excluded:
                            if gid not in history_guidelines:
                                history_guidelines[gid] = {"score": 0.0, "count": 0}
                            # Weight by session similarity
                            history_guidelines[gid]["score"] = max(
                                history_guidelines[gid]["score"], sess["score"]
                            )
                            history_guidelines[gid]["count"] += 1
        finally:
            await db.close()

    # Channel 2: Direct semantic match to guidelines
    semantic_guidelines: dict[str, float] = {}
    similar_guides = await search_similar(
        intent_text, entity_type="guideline",
        limit=10, min_score=0.45,
    )
    for g in similar_guides:
        if g["entity_id"] not in excluded:
            semantic_guidelines[g["entity_id"]] = g["score"]

    # Merge candidates
    all_candidates = set(history_guidelines.keys()) | set(semantic_guidelines.keys())
    if not all_candidates:
        return []

    # Channel 3: Effectiveness scores
    effectiveness: dict[str, dict] = {}
    from db import get_db
    db = await get_db()
    try:
        placeholders = ",".join("?" * len(all_candidates))
        params = list(all_candidates)
        if workspace_id:
            cur = await db.execute(
                f"""SELECT guideline_id, avg_quality, quality_delta, confidence, session_count
                    FROM guideline_effectiveness
                    WHERE guideline_id IN ({placeholders}) AND workspace_id = ?""",
                params + [workspace_id],
            )
        else:
            cur = await db.execute(
                f"""SELECT guideline_id, avg_quality, quality_delta, confidence, session_count
                    FROM guideline_effectiveness
                    WHERE guideline_id IN ({placeholders})""",
                params,
            )
        for row in await cur.fetchall():
            effectiveness[row["guideline_id"]] = {
                "avg_quality": row["avg_quality"],
                "quality_delta": row["quality_delta"],
                "confidence": row["confidence"],
                "session_count": row["session_count"],
            }

        # Fetch guideline names for display
        guideline_names: dict[str, str] = {}
        cur = await db.execute(
            f"SELECT id, name FROM guidelines WHERE id IN ({placeholders})",
            list(all_candidates),
        )
        for row in await cur.fetchall():
            guideline_names[row["id"]] = row["name"]

        # Fetch guideline dense texts for cross-encoder reranking
        guideline_dense_texts: dict[str, str] = {}
        cur = await db.execute(
            f"""SELECT entity_id, dense_text FROM embeddings
                WHERE entity_type = 'guideline' AND entity_id IN ({placeholders})""",
            list(all_candidates),
        )
        for row in await cur.fetchall():
            guideline_dense_texts[row["entity_id"]] = row["dense_text"]
    finally:
        await db.close()

    # Cross-encoder reranking: score each candidate against the intent
    # directly (cross-attention) for better relevance than cosine similarity.
    rerank_scores: dict[str, float] = {}
    if guideline_dense_texts:
        try:
            from embedder import rerank as cross_encoder_rerank
            candidate_ids = list(guideline_dense_texts.keys())
            candidate_docs = [guideline_dense_texts[gid] for gid in candidate_ids]
            raw_scores = await cross_encoder_rerank(intent_text, candidate_docs)
            if raw_scores and len(raw_scores) == len(candidate_ids):
                min_s = min(raw_scores)
                max_s = max(raw_scores)
                spread = max_s - min_s
                if spread > 1.0 and max_s > RERANK_RAW_FLOOR:
                    # Min-max normalize to [0.45, 0.95] — matches the embedding
                    # similarity range so the composite formula works unchanged.
                    for gid, raw in zip(candidate_ids, raw_scores):
                        rerank_scores[gid] = 0.45 + 0.50 * (raw - min_s) / spread
                    logger.debug(
                        "Cross-encoder reranked %d guidelines (spread=%.1f)",
                        len(rerank_scores), spread,
                    )
                else:
                    logger.debug("Cross-encoder spread too small (%.2f), using embedding similarity", spread)
        except Exception:
            logger.debug("Cross-encoder rerank unavailable, using embedding similarity")

    # Score and rank
    results = []
    for gid in all_candidates:
        hist = history_guidelines.get(gid, {"score": 0.0, "count": 0})
        sem = semantic_guidelines.get(gid, 0.0)
        eff = effectiveness.get(gid, {"avg_quality": 0.5, "quality_delta": 0.0, "confidence": 0.0, "session_count": 0})

        # Cross-encoder provides better ranking than cosine similarity;
        # fall back to embedding similarity when reranker is unavailable.
        if gid in rerank_scores:
            best_similarity = rerank_scores[gid]
        else:
            best_similarity = max(hist["score"], sem)

        # Effectiveness contribution (quality_delta, clamped to 0..1)
        eff_score = max(0.0, min(1.0, 0.5 + eff["quality_delta"]))

        # Adaptive composite: weight shifts based on data availability.
        # With no usage history, similarity drives the score (~90%).
        # As effectiveness data accumulates, it earns more weight.
        has_history = eff["session_count"] > 0
        if has_history:
            # Confidence grows with samples (asymptotic to 1.0), so
            # effectiveness weight scales from ~0.15 to ~0.35
            eff_weight = 0.15 + 0.20 * eff["confidence"]
            conf_weight = 0.05 + 0.10 * eff["confidence"]
            sim_weight = 1.0 - eff_weight - conf_weight
            composite = (
                best_similarity * sim_weight
                + eff_score * eff_weight
                + eff["confidence"] * conf_weight
            )
        else:
            # Cold start: almost entirely semantic similarity
            composite = best_similarity * 0.90 + 0.10

        # Generality penalty: guidelines that match many distinct sessions
        # are probably generic and noisy — dampen their score.
        composite *= _generality_penalty(gid)

        if composite < min_score:
            continue

        # Determine source
        in_history = gid in history_guidelines
        in_semantic = gid in semantic_guidelines
        in_rerank = gid in rerank_scores
        if in_rerank:
            source = "reranked"
        elif in_history and in_semantic:
            source = "both"
        elif in_history:
            source = "history"
        else:
            source = "semantic"

        # Build reason string
        reason_parts = []
        if in_history and hist["count"] > 0:
            reason_parts.append(f"Used in {hist['count']} similar session{'s' if hist['count'] > 1 else ''}")
        if eff["session_count"] > 0:
            delta_pct = int(eff["quality_delta"] * 100)
            sign = "+" if delta_pct >= 0 else ""
            reason_parts.append(f"{int(eff['avg_quality'] * 100)}% avg quality ({sign}{delta_pct}% vs baseline)")
        if not reason_parts and in_rerank:
            reason_parts.append(f"Matches your task ({int(best_similarity * 100)}% relevance)")
        elif not reason_parts and in_semantic:
            reason_parts.append(f"Semantically matches your task ({int(sem * 100)}%)")

        results.append({
            "guideline_id": gid,
            "name": guideline_names.get(gid, "Unknown"),
            "score": round(composite, 3),
            "reason": " with ".join(reason_parts) if reason_parts else "Relevant to task",
            "source": source,
            "effectiveness": eff,
        })

    results.sort(key=lambda r: r["score"], reverse=True)
    return results[:limit]


async def _maybe_push_recommendations(session_id: str, broadcast_fn=None):
    """Compute and push recommendations if they've changed."""
    buf = _intent_buffers.get(session_id)
    if not buf:
        return

    try:
        intent_text = buf.dense_text()
        if not intent_text:
            return

        # Get currently attached guidelines for this session
        attached: set[str] = set()
        from db import get_db
        db = await get_db()
        try:
            cur = await db.execute(
                "SELECT guideline_id FROM session_guidelines WHERE session_id = ?",
                (session_id,),
            )
            for row in await cur.fetchall():
                attached.add(row["guideline_id"])
        finally:
            await db.close()

        excluded = attached | buf._dismissed

        # Dynamic min_score: strict early on, relaxes with more context
        msg_count = len(buf.user_messages)
        dynamic_min_score = MIN_SCORE_NORMAL if msg_count >= 3 else MIN_SCORE_EARLY

        try:
            recs = await recommend_guidelines(
                intent_text,
                workspace_id=buf.workspace_id,
                session_id=session_id,
                excluded=excluded,
                limit=5,
                min_score=dynamic_min_score,
            )
        except Exception:
            logger.exception("Failed to compute guideline recommendations for session %s", session_id)
            return

        if not recs:
            buf.mark_recommended()
            return

        # Dedup: check if these are the same recs we last pushed
        rec_hash = hashlib.md5(json.dumps([r["guideline_id"] for r in recs]).encode()).hexdigest()
        if rec_hash == buf._last_recommendation_hash:
            buf.mark_recommended()
            return

        buf._last_recommendation_hash = rec_hash
        buf.mark_recommended()

        # Auto-attach if workspace has advisor_auto_attach enabled
        if buf.workspace_id:
            db = await get_db()
            try:
                cur = await db.execute(
                    "SELECT advisor_auto_attach FROM workspaces WHERE id = ?",
                    (buf.workspace_id,),
                )
                ws_row = await cur.fetchone()
                if ws_row and ws_row["advisor_auto_attach"]:
                    for rec in recs:
                        if rec["score"] >= AUTO_ATTACH_THRESHOLD:
                            await db.execute(
                                "INSERT OR IGNORE INTO session_guidelines (session_id, guideline_id) VALUES (?, ?)",
                                (session_id, rec["guideline_id"]),
                            )
                            logger.info(
                                "Auto-attached guideline '%s' to session %s (score=%.2f)",
                                rec["name"], session_id, rec["score"],
                            )
                    await db.commit()
            finally:
                await db.close()

        # Broadcast via WebSocket
        if broadcast_fn:
            try:
                await broadcast_fn({
                    "type": "guideline_recommendation",
                    "session_id": session_id,
                    "recommendations": recs,
                })
            except Exception:
                logger.warning("Failed to broadcast guideline recommendations")

        # Record recommendations for generality tracking
        for rec in recs:
            await _record_recommendation(rec["guideline_id"], session_id)

        # Emit event
        try:
            from event_bus import emit
            from commander_events import CommanderEvent
            await emit(CommanderEvent.GUIDELINE_RECOMMENDED, {
                "session_id": session_id,
                "workspace_id": buf.workspace_id,
                "count": len(recs),
                "top_guideline": recs[0]["name"] if recs else None,
            })
        except Exception:
            logger.warning("Failed to emit GUIDELINE_RECOMMENDED event")
    finally:
        # Clear in-flight flag so future intent changes can trigger new recommendations
        buf = _intent_buffers.get(session_id)
        if buf:
            buf._rec_in_flight = False


# ── Session Analysis (post-hoc) ────────────────────────────────────────────

async def analyze_session(session_id: str):
    """Full post-session analysis: score messages, aggregate quality, update effectiveness.

    Called as a background task when a session exits.
    """
    from db import get_db

    # 1. Get session metadata
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT workspace_id, active_guideline_ids FROM sessions WHERE id = ?",
            (session_id,),
        )
        session = await cur.fetchone()
        if not session:
            return
        workspace_id = session["workspace_id"]
        try:
            guideline_ids = json.loads(session["active_guideline_ids"] or "[]")
        except (json.JSONDecodeError, TypeError):
            guideline_ids = []
    finally:
        await db.close()

    # 2. Collect user messages from multiple sources
    from server import get_session_turns
    messages = get_session_turns(session_id)

    if not messages:
        # Try DB messages
        db = await get_db()
        try:
            cur = await db.execute(
                "SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_at",
                (session_id,),
            )
            rows = await cur.fetchall()
            messages = [r["content"] for r in rows if r["content"]]
        finally:
            await db.close()

    if not messages:
        logger.debug("No messages found for session %s, skipping analysis", session_id)
        return

    # 3. Score all messages
    scores = await score_message_batch(messages)
    if not scores or all(s is None for s in scores):
        return

    # 4. Persist per-message scores
    db = await get_db()
    try:
        for text, score_dict in zip(messages, scores):
            if score_dict is None:
                continue
            msg_hash = hashlib.sha256(text.encode()).hexdigest()[:16]
            await db.execute(
                """INSERT INTO message_scores (session_id, message_hash, satisfaction, certainty, engagement, correction)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (session_id, msg_hash,
                 score_dict.get("satisfaction"), score_dict.get("certainty"),
                 score_dict.get("engagement"), score_dict.get("correction")),
            )
        await db.commit()
    finally:
        await db.close()

    # 5. Aggregate session quality
    quality = await aggregate_session_quality(session_id, workspace_id, guideline_ids)

    # 6. Update guideline effectiveness
    if quality is not None and guideline_ids:
        await update_guideline_effectiveness(workspace_id, guideline_ids, quality)

    # 7. Emit event
    try:
        from event_bus import emit
        from commander_events import CommanderEvent
        await emit(CommanderEvent.SESSION_ANALYZED, {
            "session_id": session_id,
            "workspace_id": workspace_id,
            "quality_score": quality,
            "message_count": sum(1 for s in scores if s is not None),
        })
    except Exception:
        logger.warning("Failed to emit SESSION_ANALYZED event")

    logger.info(
        "Session %s analyzed: quality=%.2f, %d messages scored",
        session_id, quality or 0.0, sum(1 for s in scores if s is not None),
    )


async def aggregate_session_quality(
    session_id: str,
    workspace_id: str | None = None,
    guideline_ids: list[str] | None = None,
) -> float | None:
    """Compute weighted average of dimension scores and persist."""
    from db import get_db

    db = await get_db()
    try:
        cur = await db.execute(
            """SELECT AVG(satisfaction) as sat, AVG(certainty) as cert,
                      AVG(engagement) as eng, AVG(correction) as corr,
                      COUNT(*) as cnt
               FROM message_scores WHERE session_id = ?""",
            (session_id,),
        )
        row = await cur.fetchone()
        if not row or not row["cnt"]:
            return None

        sat = row["sat"] or 0.5
        cert = row["cert"] or 0.5
        eng = row["eng"] or 0.5
        corr = row["corr"] or 0.5

        quality = (
            sat * DIMENSION_WEIGHTS["satisfaction"]
            + corr * DIMENSION_WEIGHTS["correction"]
            + eng * DIMENSION_WEIGHTS["engagement"]
            + cert * DIMENSION_WEIGHTS["certainty"]
        )

        await db.execute(
            """INSERT OR REPLACE INTO session_quality
               (session_id, workspace_id, score, satisfaction_avg, certainty_avg,
                engagement_avg, correction_avg, message_count, guideline_ids, analyzed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))""",
            (session_id, workspace_id, quality, sat, cert, eng, corr,
             row["cnt"], json.dumps(guideline_ids or [])),
        )
        await db.commit()
        return quality
    finally:
        await db.close()


async def update_guideline_effectiveness(
    workspace_id: str | None,
    guideline_ids: list[str],
    quality_score: float,
):
    """Update rolling effectiveness for each guideline used in this session."""
    from db import get_db

    db = await get_db()
    try:
        # Get baseline quality for sessions WITHOUT each guideline
        cur = await db.execute(
            "SELECT AVG(score) as baseline FROM session_quality WHERE workspace_id = ?",
            (workspace_id,),
        )
        baseline_row = await cur.fetchone()
        baseline = baseline_row["baseline"] if baseline_row and baseline_row["baseline"] else 0.5

        for gid in guideline_ids:
            eff_id = f"{gid}:{workspace_id or 'global'}"
            cur = await db.execute(
                "SELECT session_count, avg_quality FROM guideline_effectiveness WHERE id = ?",
                (eff_id,),
            )
            existing = await cur.fetchone()

            if existing:
                old_count = existing["session_count"]
                old_avg = existing["avg_quality"]
                new_count = old_count + 1
                # Running average
                new_avg = (old_avg * old_count + quality_score) / new_count
                delta = new_avg - baseline
                # Confidence grows with sample size, asymptotic to 1.0
                confidence = min(1.0, new_count / (new_count + 5.0))

                await db.execute(
                    """UPDATE guideline_effectiveness
                       SET session_count = ?, avg_quality = ?, quality_delta = ?,
                           confidence = ?, updated_at = datetime('now')
                       WHERE id = ?""",
                    (new_count, round(new_avg, 4), round(delta, 4),
                     round(confidence, 4), eff_id),
                )
            else:
                delta = quality_score - baseline
                confidence = min(1.0, 1.0 / 6.0)  # Low confidence with 1 sample

                await db.execute(
                    """INSERT INTO guideline_effectiveness
                       (id, guideline_id, workspace_id, session_count, avg_quality,
                        quality_delta, confidence, updated_at)
                       VALUES (?, ?, ?, 1, ?, ?, ?, datetime('now'))""",
                    (eff_id, gid, workspace_id, round(quality_score, 4),
                     round(delta, 4), round(confidence, 4)),
                )

        await db.commit()

        # Emit event
        try:
            from event_bus import emit
            from commander_events import CommanderEvent
            await emit(CommanderEvent.GUIDELINE_EFFECTIVENESS_UPDATED, {
                "workspace_id": workspace_id,
                "guideline_ids": guideline_ids,
                "quality_score": quality_score,
            })
        except Exception:
            pass
    finally:
        await db.close()
