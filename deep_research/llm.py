"""LLM client supporting multiple backends natively.

Backends:
  - Ollama / vLLM / LM Studio  → OpenAI-compatible chat/completions
  - Google Gemini               → Native generateContent API (key as query param)
  - Any OpenAI-compatible       → Standard Bearer auth

Auto-detects backend from the base URL.
"""

import json
import logging
import re

import aiohttp

from .config import DeepResearchConfig

logger = logging.getLogger(__name__)


def parse_json_response(text: str) -> dict:
    """Robustly parse JSON from LLM output."""
    text = text.strip()

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    if "```" in text:
        blocks = re.findall(r"```(?:json)?\s*\n?(.*?)\n?\s*```", text, re.DOTALL)
        for block in blocks:
            try:
                return json.loads(block.strip())
            except json.JSONDecodeError:
                continue

    depth = 0
    start = None
    for i, ch in enumerate(text):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start is not None:
                candidate = text[start : i + 1]
                try:
                    return json.loads(candidate)
                except json.JSONDecodeError:
                    cleaned = re.sub(r",\s*([}\]])", r"\1", candidate)
                    try:
                        return json.loads(cleaned)
                    except json.JSONDecodeError:
                        start = None
                        continue

    raise ValueError(f"Could not parse JSON from LLM response: {text[:300]}...")


def _detect_backend(base_url: str) -> str:
    """Detect which backend we're talking to from the URL."""
    if "generativelanguage.googleapis.com" in base_url:
        return "gemini"
    if "localhost" in base_url or "127.0.0.1" in base_url:
        return "ollama"
    return "openai"


class LLMClient:
    """Multi-backend LLM client with model routing."""

    def __init__(self, config: DeepResearchConfig, router=None):
        self.base_url = config.llm_base_url.rstrip("/")
        self.default_model = config.llm_model
        self.api_key = config.llm_api_key
        self.temperature = config.llm_temperature
        self.max_tokens = config.llm_max_tokens
        self.router = router
        self.backend = _detect_backend(self.base_url)
        self._session: aiohttp.ClientSession | None = None
        logger.info("LLM backend: %s (%s)", self.backend, self.base_url)

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=180)
            )
        return self._session

    def _resolve_model(self, task_hint: str | None = None) -> str:
        if not self.router or not task_hint:
            return self.default_model
        from .model_router import classify_task
        tier = classify_task(task_hint)
        model = self.router.get_model(tier)
        if model != self.default_model:
            logger.info("Routed '%s' → %s (%s)", task_hint, model, tier.value)
        return model

    async def generate(
        self,
        prompt: str,
        system: str | None = None,
        json_mode: bool = False,
        task_hint: str | None = None,
    ) -> str:
        if self.backend == "gemini":
            return await self._generate_gemini(prompt, system, json_mode, task_hint)
        return await self._generate_openai(prompt, system, json_mode, task_hint)

    # ── Gemini native API ──────────────────────────────────────────

    async def _generate_gemini(
        self, prompt: str, system: str | None, json_mode: bool, task_hint: str | None
    ) -> str:
        """Native Gemini generateContent API — uses key as query param."""
        session = await self._get_session()
        model = self._resolve_model(task_hint)

        # Build contents
        contents = []
        if system:
            # Gemini uses systemInstruction, not a system message
            pass  # handled below
        contents.append({"role": "user", "parts": [{"text": prompt}]})

        body: dict = {
            "contents": contents,
            "generationConfig": {
                "temperature": self.temperature,
            },
        }
        if system:
            body["systemInstruction"] = {"parts": [{"text": system}]}
        if json_mode:
            body["generationConfig"]["responseMimeType"] = "application/json"

        url = f"{self.base_url}/models/{model}:generateContent?key={self.api_key}"
        logger.debug("Gemini → %s task=%s", model, task_hint or "default")

        async with session.post(url, json=body) as resp:
            if resp.status != 200:
                err = await resp.text()
                raise RuntimeError(f"Gemini error {resp.status}: {err[:500]}")
            data = await resp.json()

        try:
            content = data["candidates"][0]["content"]["parts"][0]["text"]
        except (KeyError, IndexError):
            raise RuntimeError(f"Unexpected Gemini response: {json.dumps(data)[:500]}")

        logger.debug("Gemini ← %d chars (model=%s)", len(content), model)
        return content

    # ── OpenAI-compatible API (Ollama, vLLM, etc.) ─────────────────

    async def _generate_openai(
        self, prompt: str, system: str | None, json_mode: bool, task_hint: str | None
    ) -> str:
        session = await self._get_session()
        model = self._resolve_model(task_hint)

        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        body: dict = {
            "model": model,
            "messages": messages,
            "temperature": self.temperature,
        }
        if self.backend != "ollama":
            body["max_tokens"] = self.max_tokens
        if json_mode:
            body["response_format"] = {"type": "json_object"}

        headers = {}
        if self.api_key and self.backend != "ollama":
            headers["Authorization"] = f"Bearer {self.api_key}"

        url = f"{self.base_url}/chat/completions"
        logger.debug("OpenAI → %s model=%s task=%s", url, model, task_hint or "default")

        async with session.post(url, json=body, headers=headers) as resp:
            if resp.status != 200:
                err = await resp.text()
                raise RuntimeError(f"LLM error {resp.status}: {err[:500]}")
            data = await resp.json()

        content = data["choices"][0]["message"]["content"]
        logger.debug("OpenAI ← %d chars (model=%s)", len(content), model)
        return content

    # ── Shared ─────────────────────────────────────────────────────

    async def generate_json(
        self, prompt: str, system: str | None = None, task_hint: str | None = None
    ) -> dict:
        try:
            text = await self.generate(prompt, system, json_mode=True, task_hint=task_hint)
            return parse_json_response(text)
        except (RuntimeError, ValueError) as e:
            logger.debug("JSON mode failed (%s), retrying without", e)

        text = await self.generate(prompt, system, json_mode=False, task_hint=task_hint)
        return parse_json_response(text)

    async def close(self):
        if self._session and not self._session.closed:
            await self._session.close()
            self._session = None
