"""LLM client — one call surface over many providers.

Where a request goes is decided by the provider registry (`providers.py`) and
resolved per task tier by the config, so this module only has to know two wire
formats:

  - openai → POST {base_url}/chat/completions with Bearer auth
  - gemini → POST {base_url}/models/{model}:generateContent?key=…

Per-provider quirks (which field caps output, whether JSON mode exists, what
temperature is legal) come from the registry entry, never from sniffing the URL.

Rate limits (429) and transient 5xx are retried with exponential backoff —
hosted endpoints throttle hard enough that a long research loop dies without it.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import replace

import aiohttp

from .config import DeepResearchConfig, Endpoint

logger = logging.getLogger(__name__)

MAX_RETRIES = 5
RETRY_BASE_DELAY = 2.0   # seconds, doubled per attempt
RETRY_MAX_DELAY = 60.0


class LLMHTTPError(RuntimeError):
    """Non-200 from the LLM endpoint, carrying the status code."""

    def __init__(self, message: str, status: int):
        super().__init__(message)
        self.status = status


def _retry_after(headers) -> float | None:
    """Seconds from a Retry-After header, if it is a plain number we trust."""
    raw = headers.get("Retry-After") or headers.get("retry-after")
    if not raw:
        return None
    try:
        return min(float(raw), RETRY_MAX_DELAY)
    except ValueError:
        return None  # HTTP-date form — fall back to our own backoff


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


class LLMClient:
    """Provider-agnostic LLM client with per-tier model routing."""

    def __init__(self, config: DeepResearchConfig, router=None):
        self.config = config
        self.temperature = config.llm_temperature
        self.max_tokens = config.llm_max_tokens
        self.router = router
        self.default_endpoint = config.endpoint()
        self.tier_endpoints = config.tier_endpoints()
        self._session: aiohttp.ClientSession | None = None
        logger.info("LLM default endpoint: %s @ %s",
                    self.default_endpoint, self.default_endpoint.base_url)

    def endpoint_for(self, task_hint: str | None = None) -> Endpoint:
        """Where a request for this task goes — the one way to ask.

        Callers that build their own request (tools.py needs the tool-calling
        shape this client does not model) resolve through here rather than
        reading fields off the client, so provider quirks, per-tier routing and
        auth stay in one place.
        """
        return self._resolve_endpoint(task_hint)

    def request_headers(self, endpoint: Endpoint) -> dict:
        """Auth and provider headers for a request to `endpoint`."""
        headers = dict(endpoint.provider.extra_headers)
        # ``needs_key`` means a key is mandatory, not that optional bearer
        # credentials must be discarded. Registry-backed custom OpenAI-
        # compatible endpoints provide their key explicitly for this run.
        if endpoint.api_key:
            headers["Authorization"] = f"Bearer {endpoint.api_key}"
        return headers

    def chat_url(self, endpoint: Endpoint) -> str:
        return f"{endpoint.base_url.rstrip('/')}/chat/completions"

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=180)
            )
        return self._session

    def _resolve_endpoint(self, task_hint: str | None = None) -> Endpoint:
        if not task_hint:
            return self.default_endpoint

        from .model_router import classify_task
        tier = classify_task(task_hint).value
        endpoint = self.tier_endpoints.get(tier, self.default_endpoint)

        # Ollama auto-discovery names a model that exists on the host it probed —
        # so it may only rename a model ON that host. Applying it to a tier that
        # points elsewhere produced things like "openai:llama3:8b", a local model
        # name sent to a remote API.
        if self.router and self._router_probed(endpoint):
            from .model_router import TaskTier
            discovered = self.router.get_model(TaskTier(tier))
            if discovered and discovered != endpoint.model:
                endpoint = replace(endpoint, model=discovered)

        if str(endpoint) != str(self.default_endpoint):
            logger.info("Routed '%s' → %s (%s)", task_hint, endpoint, tier)
        return endpoint

    def _router_probed(self, endpoint: Endpoint) -> bool:
        """Did the model router discover its models on this endpoint's host?"""
        probed = (getattr(self.router, "base_url", "") or "").rstrip("/")
        host = endpoint.base_url.rstrip("/").removesuffix("/v1")
        return bool(probed) and probed.removesuffix("/v1") == host

    async def generate(
        self,
        prompt: str,
        system: str | None = None,
        json_mode: bool = False,
        task_hint: str | None = None,
    ) -> str:
        endpoint = self._resolve_endpoint(task_hint)
        if json_mode and not endpoint.provider.json_mode:
            # e.g. Anthropic's OpenAI-compat layer silently ignores it.
            logger.debug("%s has no JSON mode — relying on prompt + parser",
                         endpoint.provider.name)
            json_mode = False
        if endpoint.backend == "gemini":
            return await self._generate_gemini(endpoint, prompt, system, json_mode)
        return await self._generate_openai(endpoint, prompt, system, json_mode)

    # ── Retry ──────────────────────────────────────────────────────

    async def _post_json(
        self,
        session: aiohttp.ClientSession,
        url: str,
        body: dict,
        headers: dict,
        label: str,
    ) -> dict:
        """POST and decode JSON, backing off on 429 / 5xx."""
        delay = RETRY_BASE_DELAY
        for attempt in range(1, MAX_RETRIES + 1):
            async with session.post(url, json=body, headers=headers) as resp:
                if resp.status == 200:
                    return await resp.json()
                err = await resp.text()
                retryable = resp.status == 429 or resp.status >= 500
                if not retryable or attempt == MAX_RETRIES:
                    raise LLMHTTPError(
                        f"{label} error {resp.status}: {err[:500]}", resp.status
                    )
                wait = _retry_after(resp.headers) or delay

            logger.warning(
                "%s %d — backing off %.1fs (attempt %d/%d)",
                label, resp.status, wait, attempt, MAX_RETRIES,
            )
            await asyncio.sleep(wait)
            delay = min(delay * 2, RETRY_MAX_DELAY)

        raise LLMHTTPError(f"{label}: retries exhausted", 429)

    # ── Gemini native API ──────────────────────────────────────────

    async def _generate_gemini(
        self, endpoint: Endpoint, prompt: str, system: str | None, json_mode: bool
    ) -> str:
        """Native Gemini generateContent API — uses key as query param."""
        session = await self._get_session()

        body: dict = {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": self._temperature(endpoint)},
        }
        if system:
            body["systemInstruction"] = {"parts": [{"text": system}]}
        if json_mode:
            body["generationConfig"]["responseMimeType"] = "application/json"

        url = (
            f"{endpoint.base_url.rstrip('/')}/models/{endpoint.model}"
            f":generateContent?key={endpoint.api_key}"
        )
        logger.debug("Gemini → %s", endpoint.model)

        data = await self._post_json(session, url, body, {}, "Gemini")
        try:
            content = data["candidates"][0]["content"]["parts"][0]["text"]
        except (KeyError, IndexError):
            raise RuntimeError(f"Unexpected Gemini response: {json.dumps(data)[:500]}")

        logger.debug("Gemini ← %d chars (model=%s)", len(content), endpoint.model)
        return content

    # ── OpenAI-compatible API ──────────────────────────────────────

    def _temperature(self, endpoint: Endpoint) -> float:
        ceiling = endpoint.provider.temperature_max
        return min(self.temperature, ceiling) if ceiling else self.temperature

    async def _generate_openai(
        self, endpoint: Endpoint, prompt: str, system: str | None, json_mode: bool
    ) -> str:
        session = await self._get_session()
        provider = endpoint.provider

        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        body: dict = {
            "model": endpoint.model,
            "messages": messages,
            "temperature": self._temperature(endpoint),
        }
        if provider.max_tokens_field:
            body[provider.max_tokens_field] = self.max_tokens
        if json_mode:
            body["response_format"] = {"type": "json_object"}

        headers = self.request_headers(endpoint)

        url = f"{endpoint.base_url.rstrip('/')}/chat/completions"
        logger.debug("OpenAI → %s model=%s", url, endpoint.model)

        data = await self._post_json(session, url, body, headers, "LLM")
        try:
            content = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError):
            raise RuntimeError(f"Unexpected response: {json.dumps(data)[:500]}")

        logger.debug("OpenAI ← %d chars (model=%s)", len(content or ""), endpoint.model)
        return content or ""

    # ── Shared ─────────────────────────────────────────────────────

    async def generate_json(
        self, prompt: str, system: str | None = None, task_hint: str | None = None
    ) -> dict:
        try:
            text = await self.generate(prompt, system, json_mode=True, task_hint=task_hint)
            return parse_json_response(text)
        except LLMHTTPError as e:
            if e.status == 429 or e.status >= 500:
                raise  # throttled or endpoint down — a second call won't help
            logger.debug("JSON mode rejected (%s), retrying without", e)
        except ValueError as e:
            logger.debug("JSON parse failed (%s), retrying without json_mode", e)

        text = await self.generate(prompt, system, json_mode=False, task_hint=task_hint)
        return parse_json_response(text)

    async def close(self):
        if self._session and not self._session.closed:
            await self._session.close()
            self._session = None
