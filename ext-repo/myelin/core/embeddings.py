"""Embedding provider for Myelin coordination.

Only GeminiEmbedding is used — coordination always injects it explicitly.
"""
from __future__ import annotations

import logging
import os
from typing import Protocol, runtime_checkable

import aiohttp

logger = logging.getLogger("myelin.embeddings")


@runtime_checkable
class EmbeddingProvider(Protocol):
    """Protocol for embedding providers."""

    @property
    def dimensions(self) -> int: ...

    async def embed(self, texts: list[str]) -> list[list[float]]: ...


def build_embed_text(
    kind: str, label: str, properties: dict | None = None,
) -> str:
    """Construct embedding input text from node fields.

    Uses _dense (self-contained sentence) as the primary embedding source.
    """
    dense = (properties or {}).get("_dense")
    if dense:
        return dense

    logger.debug("Node %r missing _dense, embedding from label only", label)
    return f"{kind}: {label}"


class GeminiEmbedding:
    """Embedding provider using Gemini embedding model (3072d)."""

    MODEL = "gemini-embedding-2-preview"
    API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"
    BATCH_LIMIT = 100
    OUTPUT_DIMS = 3072

    def __init__(self, api_key: str | None = None):
        self._api_key = api_key or os.environ.get("GOOGLE_API_KEY", "")

    @property
    def dimensions(self) -> int:
        return 3072

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        if not self._api_key:
            raise ValueError("GOOGLE_API_KEY required for GeminiEmbedding")

        all_embeddings: list[list[float]] = []

        for i in range(0, len(texts), self.BATCH_LIMIT):
            batch = texts[i : i + self.BATCH_LIMIT]
            embeddings = await self._embed_batch(batch)
            all_embeddings.extend(embeddings)

        return all_embeddings

    async def _embed_batch(self, texts: list[str]) -> list[list[float]]:
        import asyncio as _aio

        url = f"{self.API_BASE}/{self.MODEL}:batchEmbedContents?key={self._api_key}"
        payload = {
            "requests": [
                {
                    "model": f"models/{self.MODEL}",
                    "content": {"parts": [{"text": t}]},
                    "outputDimensionality": self.OUTPUT_DIMS,
                }
                for t in texts
            ]
        }

        for attempt in range(1, 4):
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=payload) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        return [e["values"] for e in data["embeddings"]]
                    error = await resp.text()
                    if resp.status in (429, 503) and attempt < 3:
                        logger.warning("Embedding API %d (attempt %d/3), retrying...", resp.status, attempt)
                        await _aio.sleep(2 * attempt)
                        continue
                    logger.error("Embedding API error %d: %s", resp.status, error[:300])
                    raise RuntimeError(f"Embedding API error {resp.status}")
        raise RuntimeError("Embedding API failed after 3 retries")


def auto_detect_embedder() -> EmbeddingProvider | None:
    """Try Gemini if GOOGLE_API_KEY is set, else None."""
    if os.environ.get("GOOGLE_API_KEY"):
        return GeminiEmbedding()
    return None
