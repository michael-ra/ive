"""LLM Router — CLI-agnostic one-shot LLM calls.

Routes requests through registered APIs or any installed CLI profile in
non-interactive mode. CLI providers need no API key in Commander and use the
subscription authentication already configured on the machine.

Usage:

    data = await call_json("gemini_api:gemini-3.1-flash-lite", prompt="...", system="return JSON only")
    data = await call_json(
        "gemini_api:gemini-3.1-flash-lite",
        prompt="describe the screenshot as JSON",
        images=[{"path": "/tmp/screen.png", "media_type": "image/png"}],
    )
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import shutil
import signal
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import TypedDict

from model_providers import (
    ModelProviderError,
    VISION_TRANSPORT_KINDS,
    load_model_providers,
)

log = logging.getLogger(__name__)

# Max prompt length (bytes) before we switch from argv to stdin.
# macOS ARG_MAX is ~262144 but we leave headroom for the rest of argv + env.
_ARG_LIMIT = 200_000
_CLI_TIMEOUT_MAX_MARGIN_SECONDS = 5.0
MAX_VISION_IMAGES = 4
MAX_VISION_IMAGE_BYTES = 8 * 1024 * 1024
MAX_VISION_TOTAL_BYTES = 12 * 1024 * 1024
SUPPORTED_VISION_MEDIA_TYPES = frozenset({
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
})
_VISION_FILE_SUFFIXES = {
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}
_ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
_CLI_PERMISSION_PROMPT_RE = re.compile(
    r"\b(?:need(?:s)? (?:your )?permission|permission (?:is )?required|"
    r"requires? (?:your )?approval|waiting for (?:your )?(?:approval|permission)|"
    r"please (?:approve|grant permission)|(?:do you want|would you like) to "
    r"(?:allow|approve))\b",
    re.IGNORECASE,
)


class ImageInput(TypedDict, total=False):
    """One image source: ``media_type`` plus exactly one of ``path`` or ``data``."""

    media_type: str
    path: str | os.PathLike[str]
    data: bytes


@dataclass(frozen=True, repr=False)
class _PreparedImage:
    media_type: str
    data: bytes


@dataclass(frozen=True, repr=False)
class _StagedCLIImage:
    path: Path
    prompt_path: str
    size: int


# is_ollama_available short-cache: avoids repeated TCP-refused probes when
# Ollama is offline (each costs ~50ms). Cache window is short so a
# freshly-started Ollama is picked up within ~5s. None means "unknown".
_OLLAMA_CACHE: dict[str, tuple[float, bool]] = {}
_OLLAMA_CACHE_TTL_SECS = 5.0
_PROVIDER_HEALTH_CACHE: dict[str, tuple[float, dict]] = {}
_PROVIDER_HEALTH_CACHE_TTL_SECS = 5.0
_PROVIDER_HEALTH_LOCK = asyncio.Lock()
_PROVIDER_HEALTH_GENERATION = 0


def _resolve_profile_binary(profile) -> tuple[str | None, list[str]]:
    """Resolve a CLI profile binary, honoring fallback binary candidates."""
    tried: list[str] = []
    for name in [profile.binary, *getattr(profile, "binary_candidates", [])]:
        if not name or name in tried:
            continue
        tried.append(name)
        binary = shutil.which(name)
        if binary:
            return binary, tried
    return None, tried


def _model_args_for_profile(profile, model: str | None) -> list[str]:
    """Build model argv only when the CLI exposes a real model flag."""
    if not model:
        return []

    from cli_features import Feature

    binding = profile.binding(Feature.MODEL)
    if not binding:
        return []
    if binding.build:
        return binding.build(model) or []
    if binding.flag:
        return [binding.flag, model]
    return []


def _permission_args_for_profile(profile, mode: str | None) -> list[str]:
    """Build non-prompt permission argv through the profile's binding."""
    if not mode:
        return []

    from cli_features import Feature

    binding = profile.binding(Feature.PERMISSION_MODE)
    if not binding:
        raise ModelProviderError(
            f"CLI profile '{profile.id}' has no non-interactive permission binding",
            code="cli_noninteractive_mode_missing",
        )
    if binding.build:
        return binding.build(mode) or []
    if binding.flag:
        return [binding.flag, mode]
    raise ModelProviderError(
        f"CLI profile '{profile.id}' cannot build non-interactive permission argv",
        code="cli_noninteractive_mode_missing",
    )


def _build_one_shot_command(
    *,
    cli: str,
    profile,
    binary: str,
    full_prompt: str,
    model: str | None,
    use_stdin: bool,
    permission_mode: str | None = None,
    reasoning_effort: str | None = None,
) -> list[str]:
    """Build a non-interactive CLI invocation for one-shot LLM calls."""
    option_args = _model_args_for_profile(profile, model)
    option_args.extend(_permission_args_for_profile(profile, permission_mode))
    if reasoning_effort is not None:
        if reasoning_effort != "low":
            raise ValueError("Automatic helper effort must be low")
        if cli == "claude":
            option_args.extend(["--effort", "low"])
        elif cli == "codex":
            option_args.extend(["-c", 'model_reasoning_effort="low"'])
    return profile.build_one_shot(binary, full_prompt, option_args, use_stdin)


def _invalidate_ollama_cache() -> None:
    """Test helper / hook for callers that just started Ollama."""
    _OLLAMA_CACHE.clear()


async def is_ollama_available(
    model: str = "gemma3:1b",
    base_url: str = "http://127.0.0.1:11434",
) -> bool:
    """Check if Ollama is running and the specified model is pulled.

    Default model is ``gemma3:1b`` — a real Ollama tag (the previous default
    ``gemma4:e2b`` was a typo and never matched any pulled model, so the
    Ollama path was never actually taken on real machines).

    Results are cached for ``_OLLAMA_CACHE_TTL_SECS`` so a single sleep
    cycle (which probes once per NREM-extracted node + REM pair candidate)
    doesn't pay TCP-refused latency every iteration when Ollama is offline.
    """
    import time as _time
    now = _time.monotonic()
    base_url = base_url.rstrip("/")
    cache_key = f"{base_url}\x00{model}"
    cached = _OLLAMA_CACHE.get(cache_key)
    if cached is not None:
        cached_at, value = cached
        if now - cached_at < _OLLAMA_CACHE_TTL_SECS:
            return value

    import aiohttp
    available = False
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(f"{base_url}/api/tags", timeout=2.0) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    models = data.get("models", [])
                    pulled_names = [m.get("name", "") for m in models]

                    # Robust check: matching exact name or base name or name without version
                    for name in pulled_names:
                        if name == model or name.startswith(model + ":") or name == model.split(":")[0]:
                            available = True
                            break
    except Exception as e:
        log.warning("Ollama not available or error checking tags: %s", e)

    _OLLAMA_CACHE[cache_key] = (now, available)
    return available


# ── Gemini API direct ────────────────────────────────────────────────────

# Default: stable non-preview flash-lite tier. Cheap, free-tier-friendly,
# Gemini-3-generation reasoning. Latency depends on Google's capacity at
# the moment; if you want predictable speed prefer gemini-3-flash-preview
# or gemini-2.5-flash-lite (both empirically faster as of mid-2026).
_GEMINI_DEFAULT_MODEL = "gemini-3.1-flash-lite"
_GEMINI_TTS_DEFAULT_MODEL = "gemini-2.5-flash-preview-tts"
_GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models"


async def _resolve_setting_value(key: str) -> str | None:
    from db import get_db
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT value FROM app_settings WHERE key = ?", (key,),
        )
        row = await cur.fetchone()
        return row["value"] if row and row["value"] else None
    finally:
        await db.close()


async def _resolve_gemini_key() -> str | None:
    """Resolve the provider-owned Gemini key, then standard env configuration."""
    try:
        value = await _resolve_setting_value("api_key_gemini_api")
        if value:
            return value
    except Exception:
        # Standalone callers can run before database startup.
        pass
    return os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")


async def _resolve_provider_key(provider: dict) -> str | None:
    setting = provider.get("api_key_setting") or ""
    if not setting:
        return None
    try:
        value = await _resolve_setting_value(setting)
    except Exception as exc:
        raise ModelProviderError(
            f"provider '{provider['id']}' configuration could not be read",
            code="provider_not_configured",
        ) from exc
    if not value:
        # Env fallback for the providers that declare one (see
        # model_providers.API_KEY_ENV_FALLBACKS). start.sh loads .env/.env.local
        # before boot, so a key kept there works without being POSTed into
        # app_settings. The stored row is checked FIRST and always wins.
        from model_providers import api_key_from_env

        value = api_key_from_env(setting)
    if not value:
        raise ModelProviderError(
            f"provider '{provider['id']}' is not configured: missing API key '{setting}'",
            code="provider_not_configured",
        )
    return value


def _image_input_error(
    message: str,
    code: str = "invalid_image_input",
) -> ModelProviderError:
    return ModelProviderError(message, code=code)


def _stat_image_file(path: Path, index: int) -> int:
    try:
        file_stat = path.stat()
    except OSError as exc:
        raise _image_input_error(
            f"image {index} path could not be read",
            code="image_read_failed",
        ) from exc
    if not stat.S_ISREG(file_stat.st_mode):
        raise _image_input_error(f"image {index} path must be a regular file")
    return file_stat.st_size


def _read_image_file(path: Path, index: int) -> bytes:
    try:
        with path.open("rb") as image_file:
            return image_file.read(MAX_VISION_IMAGE_BYTES + 1)
    except OSError as exc:
        raise _image_input_error(
            f"image {index} path could not be read",
            code="image_read_failed",
        ) from exc


async def _prepare_images(
    images: list[ImageInput] | None,
) -> tuple[_PreparedImage, ...]:
    if images is None:
        return ()
    if not isinstance(images, list):
        raise _image_input_error("images must be a list")
    if len(images) > MAX_VISION_IMAGES:
        raise _image_input_error(
            f"at most {MAX_VISION_IMAGES} images may be sent",
            code="image_count_exceeded",
        )

    prepared: list[_PreparedImage] = []
    total_bytes = 0
    for index, image in enumerate(images, start=1):
        if not isinstance(image, dict):
            raise _image_input_error(f"image {index} must be an object")
        keys = set(image)
        if keys not in ({"data", "media_type"}, {"path", "media_type"}):
            raise _image_input_error(
                f"image {index} must contain media_type and exactly one of data or path"
            )

        media_type = image["media_type"]
        if (
            not isinstance(media_type, str)
            or media_type not in SUPPORTED_VISION_MEDIA_TYPES
        ):
            raise _image_input_error(
                f"image {index} media_type is unsupported",
                code="unsupported_image_media_type",
            )

        if "data" in image:
            data = image["data"]
            if not isinstance(data, bytes):
                raise _image_input_error(f"image {index} data must be bytes")
        else:
            raw_path = image["path"]
            if not isinstance(raw_path, (str, os.PathLike)) or not str(raw_path):
                raise _image_input_error(f"image {index} path must be non-empty")
            path = Path(raw_path)
            file_size = await asyncio.to_thread(_stat_image_file, path, index)
            if file_size > MAX_VISION_IMAGE_BYTES:
                raise _image_input_error(
                    f"image {index} exceeds the {MAX_VISION_IMAGE_BYTES}-byte limit",
                    code="image_too_large",
                )
            if total_bytes + file_size > MAX_VISION_TOTAL_BYTES:
                raise _image_input_error(
                    f"images exceed the {MAX_VISION_TOTAL_BYTES}-byte total limit",
                    code="image_total_size_exceeded",
                )
            data = await asyncio.to_thread(_read_image_file, path, index)

        if not data:
            raise _image_input_error(f"image {index} must not be empty")
        if len(data) > MAX_VISION_IMAGE_BYTES:
            raise _image_input_error(
                f"image {index} exceeds the {MAX_VISION_IMAGE_BYTES}-byte limit",
                code="image_too_large",
            )
        total_bytes += len(data)
        if total_bytes > MAX_VISION_TOTAL_BYTES:
            raise _image_input_error(
                f"images exceed the {MAX_VISION_TOTAL_BYTES}-byte total limit",
                code="image_total_size_exceeded",
            )
        prepared.append(_PreparedImage(media_type=media_type, data=data))
    return tuple(prepared)


def _path_in_cli_scope(path: Path, scope: Path) -> str:
    """Return a prompt-safe relative path or fail before subprocess spawn."""
    try:
        scope_root = scope.resolve(strict=True)
        resolved = path.resolve(strict=True)
        relative = resolved.relative_to(scope_root)
    except (OSError, ValueError) as exc:
        raise ModelProviderError(
            "staged CLI image path is outside the permitted working directory",
            code="cli_image_scope_violation",
        ) from exc
    return f"./{relative.as_posix()}"


def _stage_cli_images(
    scope: Path,
    images: tuple[_PreparedImage, ...],
) -> tuple[_StagedCLIImage, ...]:
    """Write bounded images into the exact directory granted to the CLI."""
    staged: list[_StagedCLIImage] = []
    try:
        scope.chmod(0o700)
        for index, image in enumerate(images, start=1):
            suffix = _VISION_FILE_SUFFIXES[image.media_type]
            destination = scope / f"ive-image-{index}{suffix}"
            with destination.open("xb") as image_file:
                image_file.write(image.data)
            destination.chmod(0o600)
            prompt_path = _path_in_cli_scope(destination, scope)
            size = destination.stat().st_size
            if size != len(image.data):
                raise OSError("staged image size mismatch")
            staged.append(_StagedCLIImage(
                path=destination.resolve(strict=True),
                prompt_path=prompt_path,
                size=size,
            ))
    except ModelProviderError:
        raise
    except (KeyError, OSError) as exc:
        raise ModelProviderError(
            "CLI image could not be staged in its permitted working directory",
            code="cli_image_staging_failed",
        ) from exc
    return tuple(staged)


def _prompt_with_cli_image_paths(
    prompt: str,
    staged: tuple[_StagedCLIImage, ...],
) -> str:
    references = "\n".join(
        f"- image {index}: {image.prompt_path}"
        for index, image in enumerate(staged, start=1)
    )
    return (
        f"{prompt}\n\n"
        "Image inputs are staged inside your current working directory. "
        "Read these local files directly and do not request access outside it:\n"
        f"{references}"
    )


def _cli_subprocess_timeout(caller_budget: float) -> float:
    margin = min(_CLI_TIMEOUT_MAX_MARGIN_SECONDS, caller_budget * 0.1)
    return caller_budget - margin


def _cli_output_requires_permission(stdout: str, stderr: str) -> bool:
    combined = _ANSI_ESCAPE_RE.sub("", f"{stdout}\n{stderr}")
    return _CLI_PERMISSION_PROMPT_RE.search(combined) is not None


async def _terminate_cli_process(proc) -> None:
    """Kill the detached CLI process group and reap its leader."""
    from subprocess_control import terminate_process_group
    await terminate_process_group(proc)


def _build_gemini_request_body(
    *,
    prompt: str,
    system: str | None,
    response_format: str | None,
    thinking_level: str | None,
    images: tuple[_PreparedImage, ...],
) -> dict:
    generation_config: dict = {"temperature": 0.2}
    if thinking_level:
        generation_config["thinkingConfig"] = {"thinkingLevel": thinking_level}
    else:
        generation_config["thinkingConfig"] = {"thinkingBudget": 0}

    parts = [
        {
            "inlineData": {
                "mimeType": image.media_type,
                "data": base64.b64encode(image.data).decode("ascii"),
            }
        }
        for image in images
    ]
    parts.append({"text": prompt})
    body: dict = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": generation_config,
    }
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}
    if response_format == "json":
        body["generationConfig"]["responseMimeType"] = "application/json"
    return body


def _provider_retry_after_s(error: object, headers: object) -> float | None:
    candidates: list[object] = []
    if hasattr(headers, "get"):
        candidates.append(headers.get("retry-after") or headers.get("Retry-After"))
    if isinstance(error, dict):
        details = error.get("details")
        if isinstance(details, list):
            for detail in details:
                if isinstance(detail, dict):
                    candidates.append(
                        detail.get("retryDelay") or detail.get("retry_delay")
                    )
        candidates.append(error.get("retry_after"))
        candidates.append(error.get("retry_after_s"))
        candidates.append(error.get("message"))

    for candidate in candidates:
        if isinstance(candidate, (int, float)) and not isinstance(candidate, bool):
            return max(0.0, float(candidate))
        if not isinstance(candidate, str):
            continue
        if re.fullmatch(r"\d+(?:\.\d+)?", candidate.strip()):
            return max(0.0, float(candidate))
        match = re.search(
            r"(?:retry(?:\s+in|\s+after)?\s*)?(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?\b",
            candidate,
            flags=re.IGNORECASE,
        )
        if match:
            return max(0.0, float(match.group(1)))
    return None


def _provider_http_error(
    provider_label: str,
    status: int,
    data: object,
    headers: object,
    *,
    secrets: tuple[str | None, ...] = (),
) -> ModelProviderError:
    error = data.get("error") if isinstance(data, dict) else None
    if not isinstance(error, dict):
        error = {}
    raw_provider_code = error.get("status") or error.get("code") or f"HTTP_{status}"
    provider_code = " ".join(str(raw_provider_code).split())[:100]
    raw_message = error.get("message") or "request failed"
    message = " ".join(str(raw_message).split())[:500]
    for secret in secrets:
        if secret:
            message = message.replace(secret, "***")

    upper_code = provider_code.upper()
    if status == 429 or upper_code in {
        "RESOURCE_EXHAUSTED",
        "RATE_LIMITED",
        "TOO_MANY_REQUESTS",
    }:
        code = "provider_rate_limited"
    elif status in {401, 403} or upper_code in {
        "UNAUTHENTICATED",
        "PERMISSION_DENIED",
    }:
        code = "provider_auth_failed"
    elif status == 413:
        code = "provider_payload_too_large"
    elif 400 <= status < 500:
        code = "provider_request_rejected"
    elif status >= 500:
        code = "provider_unavailable"
    else:
        code = "provider_http_error"

    return ModelProviderError(
        f"{provider_label} HTTP {status} ({provider_code}): {message}",
        code=code,
        provider_code=provider_code,
        retry_after_s=_provider_retry_after_s(error, headers),
    )


async def _gemini_api_call(
    prompt: str,
    system: str | None,
    timeout: float,
    response_format: str | None,
    model: str | None,
    thinking_level: str | None = None,
    *,
    api_key: str | None = None,
    base_url: str | None = None,
    images: tuple[_PreparedImage, ...] = (),
) -> str:
    """Call Gemini's generateContent endpoint directly.

    Returns the response text. Raises on any failure so the caller can
    fall through to the CLI-subprocess tier.
    """
    key = api_key or await _resolve_gemini_key()
    if not key:
        raise RuntimeError("no Gemini API key in app_settings or GEMINI_API_KEY/GOOGLE_API_KEY env")

    model_name = model or _GEMINI_DEFAULT_MODEL
    api_root = (base_url or _GEMINI_API_URL.rsplit("/models", 1)[0]).rstrip("/")
    url = f"{api_root}/models/{model_name}:generateContent"

    body = _build_gemini_request_body(
        prompt=prompt,
        system=system,
        response_format=response_format,
        thinking_level=thinking_level,
        images=images,
    )

    import aiohttp
    async with aiohttp.ClientSession() as http:
        async with http.post(
            url,
            json=body,
            headers={
                "content-type": "application/json",
                "x-goog-api-key": key,
            },
            timeout=aiohttp.ClientTimeout(total=timeout),
        ) as resp:
            try:
                data = await resp.json()
            except (aiohttp.ContentTypeError, json.JSONDecodeError) as exc:
                if resp.status != 200:
                    body = " ".join((await resp.text()).split())[:500]
                    raise _provider_http_error(
                        "Gemini API",
                        resp.status,
                        {"error": {"message": body}},
                        resp.headers,
                        secrets=(key,),
                    ) from exc
                raise RuntimeError(
                    "Gemini API returned non-JSON HTTP 200"
                ) from exc
            if resp.status != 200:
                raise _provider_http_error(
                    "Gemini API",
                    resp.status,
                    data,
                    resp.headers,
                    secrets=(key,),
                )

    # Pull the response text out of Gemini's payload shape
    try:
        text = (
            data.get("candidates", [{}])[0]
                .get("content", {})
                .get("parts", [{}])[0]
                .get("text", "")
        )
    except (IndexError, AttributeError):
        text = ""
    if not text:
        # promptFeedback often holds the safety reason when content is blocked
        feedback = data.get("promptFeedback") if isinstance(data, dict) else None
        raise RuntimeError(f"Gemini API returned no text (feedback={feedback})")
    log.info("Gemini API returned %d chars from %s", len(text), model_name)
    return text.strip()


async def gemini_tts_pcm(
    text: str,
    *,
    model: str = _GEMINI_TTS_DEFAULT_MODEL,
    voice_name: str = "Iapetus",
    language_code: str | None = None,
    timeout: int = 45,
) -> dict:
    """Generate Gemini TTS audio and return decoded PCM bytes.

    Gemini TTS currently returns raw 24kHz mono PCM data in inlineData. The
    caller can wrap it as WAV for browser playback.
    """
    key = await _resolve_gemini_key()
    if not key:
        raise RuntimeError("no Gemini API key in app_settings or GEMINI_API_KEY/GOOGLE_API_KEY env")

    clean_text = str(text or "").strip()
    if not clean_text:
        raise RuntimeError("TTS text required")

    model_name = model or _GEMINI_TTS_DEFAULT_MODEL
    url = f"{_GEMINI_API_URL}/{model_name}:generateContent"
    speech_config: dict = {
        "voiceConfig": {
            "prebuiltVoiceConfig": {
                "voiceName": voice_name or "Iapetus",
            },
        },
    }
    if language_code:
        speech_config["languageCode"] = language_code

    body = {
        "contents": [{
            "parts": [{
                "text": clean_text,
            }],
        }],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": speech_config,
        },
        "model": model_name,
    }

    import aiohttp
    async with aiohttp.ClientSession() as http:
        async with http.post(
            url,
            json=body,
            headers={
                "content-type": "application/json",
                "x-goog-api-key": key,
            },
            timeout=aiohttp.ClientTimeout(total=timeout),
        ) as resp:
            data = await resp.json()
            if resp.status != 200:
                err = data.get("error", {}) if isinstance(data, dict) else {}
                msg = err.get("message") or str(data)[:300]
                raise RuntimeError(f"Gemini TTS HTTP {resp.status}: {msg}")

    parts = []
    try:
        parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
    except (AttributeError, IndexError):
        parts = []

    inline = None
    for part in parts:
        if isinstance(part, dict):
            inline = part.get("inlineData") or part.get("inline_data")
            if inline:
                break
    if not isinstance(inline, dict) or not inline.get("data"):
        feedback = data.get("promptFeedback") if isinstance(data, dict) else None
        raise RuntimeError(f"Gemini TTS returned no audio (feedback={feedback})")

    mime_type = inline.get("mimeType") or inline.get("mime_type") or "audio/L16;codec=pcm;rate=24000"
    pcm = base64.b64decode(inline["data"])
    log.info("gemini_tts_pcm: %d bytes from %s voice=%s", len(pcm), model_name, voice_name)
    return {
        "pcm": pcm,
        "mime_type": mime_type,
        "model": model_name,
        "voice": voice_name,
        "rate": 24000,
        "channels": 1,
        "sample_width": 2,
    }


def _build_openai_compatible_payload(
    *,
    model: str,
    prompt: str,
    system: str | None,
    response_format: str | None,
    images: tuple[_PreparedImage, ...],
) -> dict:
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    if images:
        user_content = [{"type": "text", "text": prompt}]
        user_content.extend(
            {
                "type": "image_url",
                "image_url": {
                    "url": (
                        f"data:{image.media_type};base64,"
                        f"{base64.b64encode(image.data).decode('ascii')}"
                    )
                },
            }
            for image in images
        )
        messages.append({"role": "user", "content": user_content})
    else:
        messages.append({"role": "user", "content": prompt})
    payload = {
        "model": model,
        "messages": messages,
        "temperature": 0.2,
    }
    if response_format == "json":
        payload["response_format"] = {"type": "json_object"}
    return payload


async def _openai_compatible_call(
    *,
    base_url: str,
    api_key: str,
    model: str,
    prompt: str,
    system: str | None,
    timeout: float,
    response_format: str | None = None,
    images: tuple[_PreparedImage, ...] = (),
) -> str:
    """Call the shared OpenAI-compatible chat-completions contract."""
    import aiohttp

    payload = _build_openai_compatible_payload(
        model=model,
        prompt=prompt,
        system=system,
        response_format=response_format,
        images=images,
    )
    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"{base_url.rstrip('/')}/chat/completions",
            json=payload,
            headers={
                "authorization": f"Bearer {api_key}",
                "content-type": "application/json",
            },
            timeout=aiohttp.ClientTimeout(total=timeout),
        ) as resp:
            try:
                data = await resp.json()
            except (aiohttp.ContentTypeError, json.JSONDecodeError) as exc:
                if resp.status != 200:
                    body = " ".join((await resp.text()).split())[:500]
                    raise _provider_http_error(
                        "OpenAI-compatible API",
                        resp.status,
                        {"error": {"message": body}},
                        resp.headers,
                        secrets=(api_key,),
                    ) from exc
                raise RuntimeError(
                    f"OpenAI-compatible endpoint returned non-JSON HTTP {resp.status}"
                ) from exc
            if resp.status != 200:
                raise _provider_http_error(
                    "OpenAI-compatible API",
                    resp.status,
                    data,
                    resp.headers,
                    secrets=(api_key,),
                )

    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError("OpenAI-compatible endpoint returned no message content") from exc
    if isinstance(content, list):
        content = "".join(
            str(part.get("text") or "") for part in content if isinstance(part, dict)
        )
    if not isinstance(content, str) or not content.strip():
        raise RuntimeError("OpenAI-compatible endpoint returned empty message content")
    return content.strip()


async def _ollama_api_call(
    *,
    base_url: str,
    model: str,
    prompt: str,
    system: str | None,
    timeout: float,
    response_format: str | None = "json",
) -> str:
    """Call the resolved Ollama provider endpoint once."""
    import aiohttp

    if not await is_ollama_available(model, base_url):
        raise RuntimeError("server is unreachable or the configured model is not pulled")
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    payload = {
        "model": model,
        "messages": messages,
        "stream": False,
    }
    if response_format == "json":
        payload["format"] = "json"
    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"{base_url.rstrip('/')}/api/chat",
            json=payload,
            timeout=aiohttp.ClientTimeout(total=timeout),
        ) as resp:
            if resp.status != 200:
                raise RuntimeError(f"HTTP {resp.status}: {(await resp.text())[:300]}")
            data = await resp.json()
    content = data.get("message", {}).get("content", "") if isinstance(data, dict) else ""
    if not isinstance(content, str) or not content.strip():
        raise RuntimeError("Ollama returned empty message content")
    return content.strip()


async def _cli_text_call(
    cli: str = "claude",
    model: str | None = None,
    prompt: str = "",
    system: str | None = None,
    timeout: float = 120,
    response_format: str | None = None,
    images: tuple[_PreparedImage, ...] = (),
    reasoning_effort: str | None = None,
) -> str:
    """Run the CLI transport selected by an already-resolved provider.

    Args:
        cli: Resolved CLI provider/profile id.
        model: Resolved bare model name. None = CLI default.
        prompt: The user prompt text.
        system: Optional system prompt.
        timeout: Max seconds to wait for a response.
        response_format: Accepted for transport parity; CLI prompting owns it.
        images: Bounded image bytes to stage inside the CLI working directory.

    Returns:
        The LLM's text response (stripped).

    Raises:
        ModelProviderError: For named CLI safety and response failures.
        RuntimeError: If the configured binary is unavailable.
    """
    from cli_profiles import get_profile
    profile = get_profile(cli)

    if images and not profile.vision_path_capable:
        raise ModelProviderError(
            f"CLI profile '{cli}' is not verified vision-capable",
            code="missing_capability",
        )
    if images and not profile.vision_permission_mode:
        raise ModelProviderError(
            f"CLI profile '{cli}' has no non-interactive vision mode",
            code="cli_noninteractive_mode_missing",
        )

    binary, tried = _resolve_profile_binary(profile)
    if not binary:
        label = "/".join(tried) or profile.binary or cli
        raise RuntimeError(f"{label} CLI not found in PATH")

    # Merge system prompt into the user prompt; profile adapters own argv shape.
    full_prompt = prompt
    if system:
        full_prompt = f"{system}\n\n---\n\n{full_prompt}"
    vision_workspace: tempfile.TemporaryDirectory[str] | None = None
    try:
        cwd = "/tmp"
        staged: tuple[_StagedCLIImage, ...] = ()
        if images:
            try:
                vision_workspace = tempfile.TemporaryDirectory(
                    prefix="ive_cli_vision_"
                )
            except OSError as exc:
                raise ModelProviderError(
                    "CLI image staging directory could not be created",
                    code="cli_image_staging_failed",
                ) from exc
            scope = Path(vision_workspace.name).resolve(strict=True)
            staged = await asyncio.to_thread(_stage_cli_images, scope, images)
            full_prompt = _prompt_with_cli_image_paths(full_prompt, staged)
            cwd = str(scope)
            log.info(
                "CLI vision staging: provider=%s image_count=%d image_paths=%s",
                cli,
                len(staged),
                ", ".join(
                    f"{image.path} ({image.size} bytes)" for image in staged
                ),
            )

        use_stdin = (
            len(full_prompt.encode()) > _ARG_LIMIT
            or profile.prompt_mode == "stdin"
        )
        cmd = _build_one_shot_command(
            cli=cli,
            profile=profile,
            binary=binary,
            full_prompt=full_prompt,
            model=model,
            use_stdin=use_stdin,
            permission_mode=(
                profile.vision_permission_mode if images else None
            ),
            reasoning_effort=reasoning_effort,
        )

        log.info(
            "CLI provider call: %s (model=%s, prompt_len=%d)",
            cli,
            model,
            len(full_prompt),
        )

        stdin_data: bytes | None = None
        if use_stdin:
            stdin_data = full_prompt.encode()

        cli_env = os.environ.copy()
        cli_env.update({"CI": "1", "NO_COLOR": "1", "TERM": "dumb"})
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE if stdin_data else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
            env=cli_env,
            start_new_session=True,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(input=stdin_data), timeout=timeout
            )
        except asyncio.TimeoutError:
            await _terminate_cli_process(proc)
            raise ModelProviderError(
                f"CLI provider '{cli}' timed out before the caller deadline",
                code="cli_timeout",
            )
        except asyncio.CancelledError:
            # The registry resolver may enforce a tighter outer provider
            # ceiling. Never leave a cancelled CLI subprocess behind.
            await _terminate_cli_process(proc)
            raise

        result = stdout.decode(errors="replace").strip()
        error_text = stderr.decode(errors="replace").strip()
        if _cli_output_requires_permission(result, error_text):
            raise ModelProviderError(
                f"CLI provider '{cli}' requested permission in non-interactive mode",
                code="cli_permission_prompt",
            )
        if proc.returncode != 0:
            raise ModelProviderError(
                f"CLI provider '{cli}' exited with code {proc.returncode}",
                code="cli_process_failed",
            )
        if not result:
            raise ModelProviderError(
                f"CLI provider '{cli}' returned an empty response",
                code="cli_empty_response",
            )

        log.info("CLI provider '%s' returned %d chars", cli, len(result))
        return result

    finally:
        if vision_workspace is not None:
            vision_workspace.cleanup()


def _parse_json_response(text: str) -> dict:
    """Parse strict JSON plus common small-model wrappers and leading prose."""
    if not isinstance(text, str) or not text.strip():
        raise ModelProviderError(
            "model returned an empty response",
            code="invalid_model_response",
        )

    stripped = text.strip()
    candidates = [stripped]
    candidates.extend(
        match.group(1).strip()
        for match in re.finditer(
            r"```(?:json)?\s*(.*?)```", stripped, flags=re.IGNORECASE | re.DOTALL
        )
    )
    decoder = json.JSONDecoder()
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass
        for match in re.finditer(r"[\{\[]", candidate):
            try:
                parsed, _end = decoder.raw_decode(candidate[match.start():])
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                return parsed
    raise ModelProviderError(
        "model returned unparseable JSON",
        code="invalid_model_response",
    )


def _safe_error_detail(exc: Exception, secrets: tuple[str | None, ...] = ()) -> str:
    detail = " ".join(str(exc).split())[:1000] or type(exc).__name__
    for secret in secrets:
        if secret:
            detail = detail.replace(secret, "***")
    return detail[:300]


def _split_model_id(model_id: str) -> tuple[str, str]:
    if not isinstance(model_id, str) or ":" not in model_id:
        raise ModelProviderError(
            "model id must use '<provider_id>:<model_name>'",
            code="malformed_model_id",
        )
    provider_id, model_name = model_id.split(":", 1)
    if (
        not provider_id
        or not model_name
        or provider_id != provider_id.strip()
        or model_name != model_name.strip()
    ):
        raise ModelProviderError(
            "model id must use '<provider_id>:<model_name>'",
            code="malformed_model_id",
        )
    return provider_id, model_name


def _resolve_model_from_registry(
    providers: list[dict],
    model_id: str,
    *,
    required_capability: str | None = None,
) -> tuple[dict, str]:
    """Resolve one exact model id from an already-loaded registry."""
    provider_id, model_name = _split_model_id(model_id)

    provider = next((item for item in providers if item["id"] == provider_id), None)
    if provider is None:
        raise ModelProviderError(
            f"provider '{provider_id}' is not configured",
            code="unknown_provider",
        )
    if not provider["enabled"]:
        raise ModelProviderError(
            f"provider '{provider_id}' is disabled",
            code="disabled_provider",
        )
    if provider["models"] and model_name not in provider["models"]:
        raise ModelProviderError(
            f"model '{model_name}' is not configured for provider '{provider_id}'",
            code="unknown_model",
        )
    if provider["kind"] == "cli":
        from cli_profiles import PROFILES
        if provider_id not in PROFILES:
            raise ModelProviderError(
                f"provider '{provider_id}' has no matching CLI profile",
                code="provider_not_configured",
            )
    if required_capability and required_capability not in provider["capabilities"]:
        raise ModelProviderError(
            f"provider '{provider_id}' lacks required capability "
            f"'{required_capability}'",
            code="missing_capability",
        )
    return provider, model_name


async def resolve_model(
    model_id: str,
    *,
    required_capability: str | None = None,
) -> tuple[dict, str]:
    """Resolve ``provider:model`` without inference or provider fallback."""
    _split_model_id(model_id)
    providers = await load_model_providers()
    return _resolve_model_from_registry(
        providers,
        model_id,
        required_capability=required_capability,
    )


async def model_id_for_provider(
    provider_id: str,
    model_name: str | None = None,
    *,
    required_capability: str | None = "json",
) -> str:
    """Resolve an internal CLI-profile/provider pair to one strict model id.

    Persisted model settings and API request model fields must already be
    provider-qualified and go straight to ``resolve_model``. This adapter is
    only for internal records whose contract deliberately stores the CLI
    profile separately from its bare launch model (sessions and orchestration
    roles). A missing launch model selects the provider registry's first model.
    """
    providers = await load_model_providers()
    provider = next((item for item in providers if item["id"] == provider_id), None)
    if provider is None:
        raise ModelProviderError(
            f"provider '{provider_id}' is not configured",
            code="unknown_provider",
        )
    selected_model = str(model_name or "").strip()
    if not selected_model:
        if not provider["models"]:
            raise ModelProviderError(
                f"provider '{provider_id}' has no configured model",
                code="provider_not_configured",
            )
        selected_model = provider["models"][0]
    model_id = f"{provider_id}:{selected_model}"
    _resolve_model_from_registry(
        providers,
        model_id,
        required_capability=required_capability,
    )
    return model_id


def _validate_timeout(timeout_s: float | None) -> float | None:
    if timeout_s is None:
        return None
    if (
        isinstance(timeout_s, bool)
        or not isinstance(timeout_s, (int, float))
        or timeout_s <= 0
    ):
        raise ModelProviderError(
            "timeout_s must be a positive number",
            code="invalid_timeout",
        )
    return float(timeout_s)


async def _call_provider_once(
    provider: dict,
    model_name: str,
    *,
    prompt: str,
    system: str | None,
    timeout_s: float | None,
    response_format: str | None,
    images: tuple[_PreparedImage, ...],
    reasoning_effort: str | None = None,
) -> str:
    """Dispatch one resolved provider without selecting any fallback."""
    provider_timeout = provider["timeout_ms"] / 1000.0
    # The registry default protects latency-sensitive text callers; a vision
    # caller can opt into the larger workload budget it explicitly supplies.
    if timeout_s is None:
        effective_timeout = provider_timeout
    elif images:
        effective_timeout = timeout_s
    else:
        effective_timeout = min(provider_timeout, timeout_s)

    kind = provider["kind"]
    if images and kind not in VISION_TRANSPORT_KINDS:
        raise ModelProviderError(
            f"provider '{provider['id']}' kind '{kind}' has no vision transport",
            code="missing_capability",
        )
    if images:
        log.info(
            "Vision provider call: provider=%s model=%s image_count=%d image_bytes=%d",
            provider["id"],
            model_name,
            len(images),
            sum(len(image.data) for image in images),
        )
    api_key: str | None = None
    dispatch_system = system
    if kind == "cli" and response_format == "json":
        json_hint = (
            "Reply with valid JSON only. No prose, no explanations, "
            "no markdown code fences."
        )
        dispatch_system = f"{system}\n\n{json_hint}" if system else json_hint
    try:
        if kind == "gemini_api":
            api_key = await _resolve_provider_key(provider)
            operation = _gemini_api_call(
                prompt=prompt,
                system=dispatch_system,
                timeout=effective_timeout,
                response_format=response_format,
                model=model_name,
                thinking_level="low",
                api_key=api_key,
                base_url=provider["base_url"],
                images=images,
            )
        elif kind == "openai_compatible":
            api_key = await _resolve_provider_key(provider)
            operation = _openai_compatible_call(
                base_url=provider["base_url"],
                api_key=api_key or "",
                model=model_name,
                prompt=prompt,
                system=dispatch_system,
                timeout=effective_timeout,
                response_format=response_format,
                images=images,
            )
        elif kind == "ollama":
            operation = _ollama_api_call(
                base_url=provider["base_url"],
                model=model_name,
                prompt=prompt,
                system=dispatch_system,
                timeout=effective_timeout,
                response_format=response_format,
            )
        elif kind == "cli":
            operation = _cli_text_call(
                cli=provider["id"],
                model=model_name,
                prompt=prompt,
                system=dispatch_system,
                timeout=_cli_subprocess_timeout(effective_timeout),
                response_format=response_format,
                images=images,
                **({"reasoning_effort": reasoning_effort} if reasoning_effort else {}),
            )
        else:  # Registry validation makes this unreachable.
            raise ModelProviderError(
                f"provider '{provider['id']}' has unsupported kind '{kind}'",
                code="invalid_registry",
            )
        text = await asyncio.wait_for(operation, timeout=effective_timeout)
    except ModelProviderError:
        raise
    except (asyncio.TimeoutError, TimeoutError) as exc:
        raise ModelProviderError(
            f"provider '{provider['id']}' timed out after {effective_timeout:g}s",
            code="provider_timeout",
        ) from exc
    except Exception as exc:
        detail = type(exc).__name__ if images else _safe_error_detail(exc, (api_key,))
        raise ModelProviderError(
            f"provider '{provider['id']}' call failed: {detail}",
            code="provider_call_failed",
            provider_code=type(exc).__name__,
        ) from exc
    return text


async def _run_provider_chain(
    providers: list[dict],
    provider: dict,
    model_name: str,
    *,
    prompt: str,
    system: str | None,
    timeout_s: float | None,
    response_format: str | None,
    required_capabilities: tuple[str, ...],
    allow_fallback: bool,
    images: tuple[_PreparedImage, ...],
    result_parser=None,
    reasoning_effort: str | None = None,
):
    fallback_ids = list(provider["fallback"]) if allow_fallback else []
    attempt_ids = [provider["id"], *fallback_ids]
    failures: list[tuple[str, ModelProviderError]] = []

    for index, attempt_id in enumerate(attempt_ids):
        try:
            if index == 0:
                attempt_provider, attempt_model = provider, model_name
            else:
                target = next(
                    (item for item in providers if item["id"] == attempt_id),
                    None,
                )
                if target is None:
                    raise ModelProviderError(
                        f"provider '{attempt_id}' is not configured",
                        code="unknown_provider",
                    )
                if not target["models"]:
                    raise ModelProviderError(
                        f"fallback provider '{attempt_id}' has no configured model",
                        code="provider_not_configured",
                    )
                fallback_model_id = f"{attempt_id}:{target['models'][0]}"
                for capability in required_capabilities:
                    attempt_provider, attempt_model = _resolve_model_from_registry(
                        providers,
                        fallback_model_id,
                        required_capability=capability,
                    )
            text = await _call_provider_once(
                attempt_provider,
                attempt_model,
                prompt=prompt,
                system=system,
                timeout_s=timeout_s,
                response_format=response_format,
                images=images,
                **({"reasoning_effort": reasoning_effort} if reasoning_effort else {}),
            )
            return result_parser(text) if result_parser else text
        except ModelProviderError as exc:
            failures.append((attempt_id, exc))
            if index + 1 < len(attempt_ids):
                next_id = attempt_ids[index + 1]
                log.warning(
                    "model provider fallback '%s' -> '%s' (%s): %s",
                    attempt_id,
                    next_id,
                    exc.code,
                    exc.code if images else _safe_error_detail(exc),
                )
                continue
            if len(attempt_ids) == 1:
                raise
            summary = "; ".join(
                f"{failed_id}: "
                f"{failure.code if images else _safe_error_detail(failure)}"
                for failed_id, failure in failures
            )
            raise ModelProviderError(
                f"provider fallback chain exhausted: {summary}",
                code="fallback_exhausted",
            ) from exc

    raise ModelProviderError(
        "provider fallback chain contained no attempts",
        code="fallback_exhausted",
    )


async def call_json(
    model_id: str,
    prompt: str,
    system: str | None = None,
    timeout_s: float | None = None,
    *,
    images: list[ImageInput] | None = None,
    allow_fallback: bool = False,
    reasoning_effort: str | None = None,
) -> dict:
    """Resolve provider-qualified JSON, optionally with bounded inline images.

    Each image is ``{"media_type": "image/png", "path": ...}`` or
    ``{"media_type": "image/png", "data": b"..."}``.
    """
    _split_model_id(model_id)
    caller_timeout = _validate_timeout(timeout_s)
    providers = await load_model_providers()
    required_capabilities = ("json", "vision") if images else ("json",)
    for capability in required_capabilities:
        provider, model_name = _resolve_model_from_registry(
            providers,
            model_id,
            required_capability=capability,
        )
    prepared_images = await _prepare_images(images)
    return await _run_provider_chain(
        providers,
        provider,
        model_name,
        prompt=prompt,
        system=system,
        timeout_s=caller_timeout,
        response_format="json",
        required_capabilities=required_capabilities,
        allow_fallback=allow_fallback,
        images=prepared_images,
        result_parser=_parse_json_response,
        **({"reasoning_effort": reasoning_effort} if reasoning_effort else {}),
    )


def invalidate_provider_health_cache() -> None:
    global _PROVIDER_HEALTH_GENERATION
    _PROVIDER_HEALTH_GENERATION += 1
    _PROVIDER_HEALTH_CACHE.clear()


async def _probe_provider(provider: dict) -> dict:
    import aiohttp

    result = {
        "id": provider["id"],
        "enabled": provider["enabled"],
        "reachable": False,
        "status": "unreachable",
        "reason": "provider probe failed",
    }
    if not provider["enabled"]:
        result.update(status="disabled", reason=f"provider '{provider['id']}' is disabled")
        return result

    timeout = min(2.0, max(0.1, provider["timeout_ms"] / 1000.0))
    api_key: str | None = None
    try:
        kind = provider["kind"]
        if kind == "cli":
            from cli_profiles import PROFILES
            profile = PROFILES.get(provider["id"])
            if profile is None:
                raise RuntimeError("CLI profile is not configured")
            binary, tried = _resolve_profile_binary(profile)
            if not binary:
                raise RuntimeError(f"{'/'.join(tried) or provider['id']} CLI is not installed")
        elif kind == "ollama":
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    f"{provider['base_url']}/api/tags",
                    timeout=aiohttp.ClientTimeout(total=timeout),
                ) as response:
                    if response.status != 200:
                        raise RuntimeError(f"HTTP {response.status}")
                    data = await response.json()
            pulled = {
                item.get("name", "") for item in data.get("models", [])
                if isinstance(item, dict)
            }
            missing = [model for model in provider["models"] if model not in pulled]
            if missing:
                raise RuntimeError("model not pulled: " + ", ".join(missing))
        else:
            api_key = await _resolve_provider_key(provider)
            headers = {"authorization": f"Bearer {api_key}"}
            if kind == "gemini_api":
                url = f"{provider['base_url']}/models"
                headers = {"x-goog-api-key": api_key or ""}
            else:
                url = f"{provider['base_url']}/models"
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    url,
                    headers=headers,
                    timeout=aiohttp.ClientTimeout(total=timeout),
                ) as response:
                    if response.status != 200:
                        raise RuntimeError(f"HTTP {response.status}")
        result.update(reachable=True, status="reachable", reason="reachable")
    except ModelProviderError as exc:
        result.update(status=exc.code, reason=str(exc))
    except (asyncio.TimeoutError, TimeoutError):
        result.update(status="timeout", reason=f"provider '{provider['id']}' probe timed out")
    except Exception as exc:
        detail = _safe_error_detail(exc, (api_key,))[:200]
        result.update(reason=f"provider '{provider['id']}' is unreachable: {detail}")
    return result


async def _provider_health_snapshot() -> list[dict]:
    import time as _time

    generation = _PROVIDER_HEALTH_GENERATION
    providers = await load_model_providers()
    now = _time.monotonic()
    results: list[dict | None] = [None] * len(providers)
    misses: list[tuple[int, dict, str]] = []
    for index, provider in enumerate(providers):
        cache_key = json.dumps(provider, sort_keys=True, separators=(",", ":"))
        cached = _PROVIDER_HEALTH_CACHE.get(cache_key)
        if cached and now - cached[0] < _PROVIDER_HEALTH_CACHE_TTL_SECS:
            results[index] = dict(cached[1])
        else:
            misses.append((index, provider, cache_key))

    if misses:
        probed = await asyncio.gather(*(_probe_provider(item[1]) for item in misses))
        checked_at = _time.monotonic()
        for (index, _provider, cache_key), health in zip(misses, probed):
            if generation == _PROVIDER_HEALTH_GENERATION:
                _PROVIDER_HEALTH_CACHE[cache_key] = (checked_at, dict(health))
            results[index] = health
    return [item for item in results if item is not None]


async def provider_health() -> list[dict]:
    """Report reachability with cached, de-duplicated provider probes."""
    async with _PROVIDER_HEALTH_LOCK:
        return await _provider_health_snapshot()
