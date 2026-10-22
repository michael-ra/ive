"""Durable model-provider registry shared by routing, APIs, and startup.

The registry is deliberately data-only.  Provider behavior belongs in
``llm_router``; this module owns the persisted contract and its validation.
"""
from __future__ import annotations

import asyncio
import copy
import json
import logging
import os
import re
import weakref
from contextlib import asynccontextmanager
from urllib.parse import urlsplit
from extension_model_migrations import WorkspaceModelMigrations

logger = logging.getLogger(__name__)


MODEL_PROVIDERS_SETTING = "model_providers"
GEMINI_API_PROVIDER_ID = "gemini_api"
CLI_PROVIDER_TIMEOUT_MS = 120_000
SAFETY_CLASSIFIER_TIMEOUT_MS = 7_000
# The budget a classifier call ACTUALLY gets. llm_router._call_provider_once takes
# min(provider timeout, caller timeout), so the provider's declared timeout — not
# SAFETY_CLASSIFIER_TIMEOUT_MS, which is only the outer hook ceiling and the
# eligibility rule — is what a call runs against. At the old 1500ms, measured
# production traffic (p95 1169ms, max 1511ms) put 1 call in 96 over the line; it
# failed closed, which is safe but degrades into an ask-storm that trains the
# operator to click through. 6000ms is ~4x the observed max and stays 1000ms
# under SAFETY_CLASSIFIER_TIMEOUT_MS, so the provider's own timeout is what fires
# on a genuinely hung call and the verdict is attributable.
SAFETY_CLASSIFIER_PROVIDER_TIMEOUT_MS = 6_000
DEFAULT_SAFETY_CLASSIFIER_MODEL = (
    f"{GEMINI_API_PROVIDER_ID}:gemini-3.1-flash-lite"
)
PROVIDER_KINDS = frozenset({
    "gemini_api",
    "openai_compatible",
    "ollama",
    "cli",
})
PROVIDER_CAPABILITIES = frozenset({"json", "vision"})
VISION_TRANSPORT_KINDS = frozenset({"gemini_api", "openai_compatible", "cli"})
_PROVIDER_ID_RE = re.compile(r"[a-z][a-z0-9_-]{0,62}")
_API_KINDS = frozenset({"gemini_api", "openai_compatible"})
_QUALIFIED_MODEL_SETTING_KEYS = (
    "safety_classifier_model",
    "secure_command_check_model",
    "secure_build_vet_model",
    "safety_script_allowlist_model",
    "catchup_model",
)
SAFETY_CLASSIFIER_SETTING = "safety_classifier_model"

# Env fallbacks for provider API keys, consulted by llm_router ONLY when the
# provider-owned app_settings row is empty. start.sh loads .env/.env.local into
# the process environment before the server boots, so an operator who keeps the
# key in .env.local never has to POST it. The app_settings row still wins —
# an explicitly configured key is never shadowed by an ambient env var.
API_KEY_ENV_FALLBACKS = {
    "api_key_cerebras": ("CEREBRAS_API_KEY",),
}


def api_key_from_env(api_key_setting: str) -> str | None:
    """Return the env-supplied key for one provider key setting, or None."""
    for env_name in API_KEY_ENV_FALLBACKS.get(api_key_setting or "", ()):
        value = os.environ.get(env_name)
        if value:
            return value
    return None


# ── Serialised registry writes ───────────────────────────────────────────────
#
# ``model_providers`` and ``safety_classifier_model`` are ONE invariant, not two
# independent rows: the classifier's latency gate is evaluated against the
# registry, and the registry's gate is evaluated against the classifier. Every
# write path read the state, validated, then wrote on its own connection, so two
# concurrent owner calls each validated against a state NEITHER of them ended up
# in — one PUT selects an in-budget classifier while the other pushes that same
# provider's timeout past the budget; both read the pre-write state, both pass,
# both commit 200, and the machine is left running an over-budget classifier in
# front of every tool call.
#
# One lock covers BOTH keys, and it is held across read → validate → write →
# COMMIT. The commit is inside the guard on purpose: the paths use separate
# sqlite connections, so an uncommitted write is invisible to the other
# validator and releasing at INSERT time would leave the same hole.
#
# Shape mirrors ``session_supervisor._get_lock``: a lazily created asyncio.Lock
# guarding a read-validate-write that must not interleave. Keyed by the running
# loop because an asyncio.Lock binds to the loop it first blocks on, and these
# paths are also driven from throwaway ``asyncio.run`` loops.
_registry_guards: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()


def _registry_guard_state() -> dict:
    loop = asyncio.get_running_loop()
    state = _registry_guards.get(loop)
    if state is None:
        state = {"lock": asyncio.Lock(), "holder": None}
        _registry_guards[loop] = state
    return state


@asynccontextmanager
async def model_registry_write_guard():
    """Serialise read → validate → write → commit over the registry AND the classifier."""
    state = _registry_guard_state()
    task = asyncio.current_task()
    if state["holder"] is not None and state["holder"] is task:
        # Nested from the SAME task — a server route or add_declarative_cli_profile
        # calling store_model_providers. Already exclusive; re-acquiring would
        # deadlock on a plain Lock.
        yield
        return
    async with state["lock"]:
        state["holder"] = task
        try:
            yield
        finally:
            state["holder"] = None


class ModelProviderError(RuntimeError):
    """Actionable provider configuration or dispatch failure."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "provider_error",
        provider_code: str = "",
        retry_after_s: float | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.provider_code = provider_code
        self.retry_after_s = retry_after_s


DEFAULT_MODEL_PROVIDERS = [
    {
        "id": GEMINI_API_PROVIDER_ID,
        "kind": "gemini_api",
        "base_url": "https://generativelanguage.googleapis.com/v1beta",
        "api_key_setting": "api_key_gemini_api",
        "models": ["gemini-3.1-flash-lite"],
        # Backs DEFAULT_SAFETY_CLASSIFIER_MODEL: sized so a normal classifier
        # call cannot time out. See SAFETY_CLASSIFIER_PROVIDER_TIMEOUT_MS.
        "timeout_ms": SAFETY_CLASSIFIER_PROVIDER_TIMEOUT_MS,
        "enabled": True,
        "fallback": [],
        "capabilities": ["json", "vision"],
    },
    {
        "id": "ollama",
        "kind": "ollama",
        "base_url": "http://127.0.0.1:11434",
        "api_key_setting": "",
        "models": ["gemma3:1b"],
        "timeout_ms": 1500,
        "enabled": True,
        "fallback": [GEMINI_API_PROVIDER_ID, "claude"],
        "capabilities": ["json"],
    },
    {
        "id": "mlx",
        "kind": "openai_compatible",
        "base_url": "http://127.0.0.1:8080/v1",
        "api_key_setting": "api_key_mlx",
        "models": ["default_model"],
        "timeout_ms": 1500,
        "enabled": False,
        "fallback": [],
        "capabilities": ["json"],
    },
    # Enabled so it is a SELECTABLE safety-classifier candidate out of the box
    # (1500ms fits the 7s gate budget). Enabled is not configured: with no key in
    # api_key_cerebras and none in CEREBRAS_API_KEY, dispatch raises
    # provider_not_configured and the health probe never leaves the machine. No
    # other provider lists cerebras in its fallback chain, so nothing routes here
    # implicitly — it is used only when something names cerebras:<model>.
    {
        "id": "cerebras",
        "kind": "openai_compatible",
        "base_url": "https://api.cerebras.ai/v1",
        "api_key_setting": "api_key_cerebras",
        "models": ["gpt-oss-120b"],
        "timeout_ms": 1500,
        "enabled": True,
        "fallback": [],
        "capabilities": ["json"],
    },
]


def cli_provider_from_profile(profile) -> dict:
    """Derive one registry entry from one resolved CLI profile."""
    from llm_router import _model_args_for_profile, _resolve_profile_binary

    exposes_model_choice = bool(
        _model_args_for_profile(profile, "__ive_model_probe__")
    )
    if exposes_model_choice:
        models = list(dict.fromkeys(
            str(item.get("id") or "").strip()
            for item in profile.available_models
            if isinstance(item, dict) and str(item.get("id") or "").strip()
        ))
    elif profile.adapter_kind == "declarative":
        models = [profile.default_model]
    else:
        models = ["default"]
    binary, _tried = _resolve_profile_binary(profile)
    return {
        "id": profile.id,
        "kind": "cli",
        "base_url": "",
        "api_key_setting": "",
        "models": models,
        "timeout_ms": CLI_PROVIDER_TIMEOUT_MS,
        "enabled": binary is not None,
        "fallback": [],
        "capabilities": (
            ["json", "vision"] if profile.vision_path_capable else ["json"]
        ),
    }


def cli_availability_from_providers(providers: list[dict]) -> dict[str, bool]:
    """Return the registry-owned executable availability signal for CLIs."""
    return {
        str(provider["id"]): bool(provider.get("enabled"))
        for provider in providers
        if provider.get("kind") == "cli" and provider.get("id")
    }


def default_model_providers() -> list[dict]:
    """Build startup defaults, deriving every CLI entry from its profile."""
    from cli_profiles import all_profiles

    providers = copy.deepcopy(DEFAULT_MODEL_PROVIDERS)
    cli_providers = [cli_provider_from_profile(profile) for profile in all_profiles()]

    # Keep remote/local API providers first, followed by the subscription CLI
    # family, then optional compatible endpoints.
    return [*providers[:2], *cli_providers, *providers[2:]]


def qualify_model(
    value: object,
    provider_ids: set[str],
    *,
    migrate_gemini_api_alias: bool = False,
) -> str | None:
    """Qualify one legacy persisted model value during startup migration.

    This is deliberately migration-only inference. Runtime readers must use
    ``llm_router.resolve_model`` and reject unqualified values.
    """
    raw = value.strip() if isinstance(value, str) else ""
    if not raw:
        return None
    if migrate_gemini_api_alias and raw.startswith("gemini:"):
        return f"{GEMINI_API_PROVIDER_ID}:{raw.split(':', 1)[1]}"
    prefix = raw.split(":", 1)[0] if ":" in raw else ""
    if prefix in provider_ids:
        return raw
    if raw.startswith("gemini-"):
        return f"{GEMINI_API_PROVIDER_ID}:{raw}"
    return f"claude:{raw}"


def seeded_provider_kinds() -> dict[str, str]:
    """What each SEEDED provider id MEANS: the built-in defaults plus every CLI profile.

    Provider ids are load-bearing well beyond the row they name, and the code that
    reads them runs at a different time than the write that set them:

      * ``qualify_model`` stamps a bare persisted model as ``claude:{raw}`` on the
        next boot — so ``claude`` names a subprocess CLI by construction;
      * ``seed_and_migrate_model_providers`` reasons about seeded ids (``cli_defaults``
        keyed by id, the cerebras candidate, the ``gemini`` → ``gemini_api`` move);
      * ``cli_availability_from_providers`` reports a CLI profile's binary from the
        entry with that id, and hook bindings resolve profiles by the same id.

    An id whose ``kind`` can be rewritten therefore means one thing when the write is
    validated and another after the next restart. See ``validate_model_providers``.
    """
    from cli_profiles import PROFILES

    kinds = {provider["id"]: provider["kind"] for provider in DEFAULT_MODEL_PROVIDERS}
    kinds.update({profile_id: "cli" for profile_id in PROFILES})
    return kinds


def _valid_base_url(value: str) -> bool:
    parsed = urlsplit(value)
    return (
        parsed.scheme in {"http", "https"}
        and bool(parsed.netloc)
        and not parsed.query
        and not parsed.fragment
    )


def validate_model_providers(value: object) -> list[dict]:
    """Return a normalized registry or raise a typed, actionable error."""
    if not isinstance(value, list):
        raise ModelProviderError(
            "model provider registry must be a JSON list",
            code="invalid_registry",
        )

    normalized: list[dict] = []
    seen: set[str] = set()
    # A seeded id's kind is IMMUTABLE. One accepted PUT used to recast the seeded
    # CLI id ``codex`` as {"kind": "openai_compatible", base_url, api_key_setting,
    # models}, which made it a selectable classifier candidate — a CLI id is refused
    # for subprocess cold start, an openai_compatible one is not. The rule chosen
    # here is immutability rather than re-validating against a simulated post-migration
    # registry: it is a STATIC invariant, so it holds on every write path (including
    # the raw PUT /api/settings/model_providers) with no DB, no throwaway migration
    # run, and no drift as migrations are added. It also cannot be laundered through
    # two calls — the check is keyed on the SEEDED kind, not on the stored row, so
    # deleting ``codex`` and re-adding it under another kind is refused too.
    seeded_kinds = seeded_provider_kinds()
    required = {
        "id", "kind", "base_url", "api_key_setting", "models",
        "timeout_ms", "enabled", "fallback", "capabilities",
    }
    for index, raw in enumerate(value):
        if not isinstance(raw, dict) or set(raw) != required:
            raise ModelProviderError(
                f"provider entry {index} must contain exactly: "
                + ", ".join(sorted(required)),
                code="invalid_registry",
            )

        provider_id = raw["id"]
        if not isinstance(provider_id, str) or not _PROVIDER_ID_RE.fullmatch(provider_id):
            raise ModelProviderError(
                f"provider entry {index} has an invalid id",
                code="invalid_registry",
            )
        if provider_id in seen:
            raise ModelProviderError(
                f"provider '{provider_id}' is duplicated",
                code="invalid_registry",
            )
        seen.add(provider_id)

        kind = raw["kind"]
        if kind not in PROVIDER_KINDS:
            raise ModelProviderError(
                f"provider '{provider_id}' has unsupported kind '{kind}'",
                code="invalid_registry",
            )
        seeded_kind = seeded_kinds.get(provider_id)
        if seeded_kind is not None and kind != seeded_kind:
            raise ModelProviderError(
                f"provider '{provider_id}' is seeded as kind '{seeded_kind}' and cannot "
                f"be recast as '{kind}': the id is load-bearing after a restart",
                code="seeded_provider_kind_immutable",
            )
        cli_profile = None
        if kind == "cli":
            from cli_profiles import PROFILES
            if provider_id not in PROFILES:
                raise ModelProviderError(
                    f"CLI provider '{provider_id}' has no matching CLI profile",
                    code="invalid_registry",
                )
            cli_profile = PROFILES[provider_id]

        base_url = raw["base_url"]
        if not isinstance(base_url, str):
            raise ModelProviderError(
                f"provider '{provider_id}' base_url must be a string",
                code="invalid_registry",
            )
        base_url = base_url.rstrip("/")
        if kind != "cli" and not _valid_base_url(base_url):
            raise ModelProviderError(
                f"provider '{provider_id}' needs a valid http(s) base_url",
                code="invalid_registry",
            )
        if kind == "cli" and base_url:
            raise ModelProviderError(
                f"CLI provider '{provider_id}' must have an empty base_url",
                code="invalid_registry",
            )

        api_key_setting = raw["api_key_setting"]
        expected_key = f"api_key_{provider_id}"
        if not isinstance(api_key_setting, str):
            raise ModelProviderError(
                f"provider '{provider_id}' api_key_setting must be a string",
                code="invalid_registry",
            )
        if kind in _API_KINDS and api_key_setting != expected_key:
            raise ModelProviderError(
                f"provider '{provider_id}' must store its key as '{expected_key}'",
                code="invalid_registry",
            )
        if kind not in _API_KINDS and api_key_setting:
            raise ModelProviderError(
                f"provider '{provider_id}' does not use an API key",
                code="invalid_registry",
            )

        models = raw["models"]
        if (
            not isinstance(models, list)
            or any(not isinstance(model, str) or not model.strip() for model in models)
        ):
            raise ModelProviderError(
                f"provider '{provider_id}' models must be non-empty strings",
                code="invalid_registry",
            )
        clean_models = list(dict.fromkeys(model.strip() for model in models))
        if cli_profile is not None and cli_profile.adapter_kind == "declarative":
            expected_models = [
                item["id"] for item in cli_profile.available_models
            ] if cli_profile.model_flag else [cli_profile.default_model]
            if clean_models != expected_models:
                raise ModelProviderError(
                    f"CLI provider '{provider_id}' models are owned by its declarative "
                    f"profile and must be {expected_models}",
                    code="invalid_registry",
                )

        timeout_ms = raw["timeout_ms"]
        if (
            isinstance(timeout_ms, bool)
            or not isinstance(timeout_ms, int)
            or not 100 <= timeout_ms <= 300_000
        ):
            raise ModelProviderError(
                f"provider '{provider_id}' timeout_ms must be 100-300000",
                code="invalid_registry",
            )
        if not isinstance(raw["enabled"], bool):
            raise ModelProviderError(
                f"provider '{provider_id}' enabled must be a boolean",
                code="invalid_registry",
            )

        fallback = raw["fallback"]
        if (
            not isinstance(fallback, list)
            or any(
                not isinstance(fallback_id, str)
                or not _PROVIDER_ID_RE.fullmatch(fallback_id)
                for fallback_id in fallback
            )
        ):
            raise ModelProviderError(
                f"provider '{provider_id}' fallback must contain provider ids",
                code="invalid_registry",
            )
        clean_fallback = list(dict.fromkeys(fallback))
        if len(clean_fallback) != len(fallback):
            raise ModelProviderError(
                f"provider '{provider_id}' fallback contains duplicates",
                code="invalid_registry",
            )
        if provider_id in clean_fallback:
            raise ModelProviderError(
                f"provider '{provider_id}' cannot fall back to itself",
                code="invalid_registry",
            )

        capabilities = raw["capabilities"]
        if (
            not isinstance(capabilities, list)
            or any(
                not isinstance(capability, str)
                or capability not in PROVIDER_CAPABILITIES
                for capability in capabilities
            )
        ):
            raise ModelProviderError(
                f"provider '{provider_id}' capabilities must use: "
                + ", ".join(sorted(PROVIDER_CAPABILITIES)),
                code="invalid_registry",
            )
        clean_capabilities = list(dict.fromkeys(capabilities))
        if len(clean_capabilities) != len(capabilities):
            raise ModelProviderError(
                f"provider '{provider_id}' capabilities contains duplicates",
                code="invalid_registry",
            )
        if "vision" in clean_capabilities and kind not in VISION_TRANSPORT_KINDS:
            raise ModelProviderError(
                f"provider '{provider_id}' kind '{kind}' has no vision transport",
                code="invalid_registry",
            )
        if (
            "vision" in clean_capabilities
            and cli_profile is not None
            and not cli_profile.vision_path_capable
        ):
            raise ModelProviderError(
                f"CLI profile '{provider_id}' is not verified vision-capable",
                code="invalid_registry",
            )
        if (
            "vision" in clean_capabilities
            and cli_profile is not None
            and not cli_profile.vision_permission_mode
        ):
            raise ModelProviderError(
                f"CLI profile '{provider_id}' has no non-interactive vision mode",
                code="invalid_registry",
            )

        normalized.append({
            "id": provider_id,
            "kind": kind,
            "base_url": base_url,
            "api_key_setting": api_key_setting,
            "models": clean_models,
            "timeout_ms": timeout_ms,
            "enabled": raw["enabled"],
            "fallback": clean_fallback,
            "capabilities": clean_capabilities,
        })

    provider_ids = {provider["id"] for provider in normalized}
    for provider in normalized:
        for fallback_id in provider["fallback"]:
            if fallback_id not in provider_ids:
                raise ModelProviderError(
                    f"provider '{provider['id']}' fallback references unknown provider "
                    f"'{fallback_id}'",
                    code="invalid_registry",
                )
    return normalized


async def load_model_providers(db=None) -> list[dict]:
    owns_db = db is None
    if owns_db:
        from db import get_db
        db = await get_db()
    try:
        from declarative_cli_profiles import (
            DeclarativeCLIProfileError,
            load_declarative_cli_profiles,
        )
        try:
            await load_declarative_cli_profiles(db)
        except DeclarativeCLIProfileError as exc:
            raise ModelProviderError(str(exc), code=exc.code) from exc
        cur = await db.execute(
            "SELECT value FROM app_settings WHERE key = ?",
            (MODEL_PROVIDERS_SETTING,),
        )
        row = await cur.fetchone()
        if not row:
            raise ModelProviderError(
                "model provider registry is not configured",
                code="missing_registry",
            )
        try:
            decoded = json.loads(row["value"])
        except (TypeError, json.JSONDecodeError) as exc:
            raise ModelProviderError(
                "model provider registry contains invalid JSON",
                code="invalid_registry",
            ) from exc
        return validate_model_providers(decoded)
    finally:
        if owns_db:
            await db.close()


def validate_safety_classifier_latency(
    providers: list[dict],
    model_id: str | None,
) -> None:
    """Reject a configured classifier whose provider cannot fit the hook budget."""
    if not model_id or not isinstance(model_id, str) or ":" not in model_id:
        return
    provider_id = model_id.split(":", 1)[0]
    provider = next(
        (item for item in providers if item.get("id") == provider_id),
        None,
    )
    if not provider:
        return
    is_cli = provider["kind"] == "cli"
    if not is_cli and provider["timeout_ms"] <= SAFETY_CLASSIFIER_TIMEOUT_MS:
        return
    kind_reason = (
        "CLI subprocess cold-start exceeds the gate budget"
        if is_cli
        else "the declared provider timeout exceeds the gate budget"
    )
    raise ModelProviderError(
        f"safety classifier latency budget is {SAFETY_CLASSIFIER_TIMEOUT_MS}ms, "
        f"but provider '{provider_id}' declares {provider['timeout_ms']}ms: "
        f"{kind_reason}",
        code="safety_classifier_latency_budget_exceeded",
    )


def effective_safety_classifier_model(
    providers: list[dict],
    stored: str | None,
) -> str:
    """The model that would ACTUALLY dispatch in front of the next tool call.

    The stored string is not the classifier. ``stored`` is the app_settings row
    value, or None when there is no row, and three cases fall back to something
    else entirely:

      * no row      → the seeded default is in force (this is what a DELETE of
                      the setting leaves behind);
      * ``""``      → the explicit "no LLM tier" choice; nothing dispatches;
      * unknown provider → ``qualify_model`` rewrites it to ``claude:{raw}`` on the
                      next boot, the CLI cold start blows the budget, and
                      ``seed_and_migrate_model_providers`` resets it to the default.
                      So the default is what would run — even though the row still
                      holds the operator's string right now.

    Every gate must be computed on THIS, never on the row: checking the row alone
    let a registry write bump the DEFAULT's provider unchecked, and a later DELETE
    then handed every tool call to it.
    """
    if stored is None:
        return DEFAULT_SAFETY_CLASSIFIER_MODEL
    value = stored.strip() if isinstance(stored, str) else ""
    if not value:
        return ""
    provider_id = value.split(":", 1)[0] if ":" in value else ""
    known = any(provider.get("id") == provider_id for provider in providers)
    return value if known else DEFAULT_SAFETY_CLASSIFIER_MODEL


async def validate_effective_safety_classifier_latency(db, providers: list[dict]) -> None:
    """Refuse a registry write that would leave an over-budget EFFECTIVE classifier.

    TWO models are checked, not one:

      * the classifier this registry would actually dispatch right now, and
      * DEFAULT_SAFETY_CLASSIFIER_MODEL, unconditionally.

    The default is checked even when something else is selected because it is the
    fallback that EVERY unselection path lands on — deleting the setting, removing
    the selected provider, or the startup migration resetting an unusable value.
    Leaving the default's provider over budget is therefore a latent bypass: the
    registry write looks unrelated to the classifier, and one ordinary DELETE
    later it is the thing running in front of every tool call. Checking only what
    is selected today is exactly the hole that shipped.
    """
    cur = await db.execute(
        "SELECT value FROM app_settings WHERE key = ?",
        (SAFETY_CLASSIFIER_SETTING,),
    )
    row = await cur.fetchone()
    stored = row["value"] if row else None
    validate_safety_classifier_latency(
        providers, effective_safety_classifier_model(providers, stored)
    )
    validate_safety_classifier_latency(providers, DEFAULT_SAFETY_CLASSIFIER_MODEL)


def safety_classifier_model_eligibility(
    providers: list[dict],
    model_id: str,
) -> ModelProviderError | None:
    """None iff ``model_id`` may serve as the safety classifier, else WHY not.

    The eligibility a picker shows and the verdict a write gets MUST come from the
    same two checks — registry resolution with the ``json`` capability, then the
    latency budget — or the UI will offer a choice the API refuses."""
    from llm_router import _resolve_model_from_registry

    try:
        provider, _model_name = _resolve_model_from_registry(
            providers, model_id, required_capability="json"
        )
        validate_safety_classifier_latency([provider], model_id)
    except ModelProviderError as exc:
        return exc
    return None


async def store_safety_classifier_model(db, model_id: object) -> str:
    """Validate and persist ``safety_classifier_model``; return what was stored.

    Every write of this key runs the SAME pair of checks as
    ``PUT /api/settings/safety_classifier_model``. An empty value is the explicit
    "no LLM tier" choice and is stored as an empty row (distinct from an absent
    row, which means "use the default") — it needs no provider validation because
    it dispatches to no provider."""
    async with model_registry_write_guard():
        value = "" if model_id is None else str(model_id).strip()
        if value:
            providers = await load_model_providers(db)
            error = safety_classifier_model_eligibility(providers, value)
            if error is not None:
                raise error
        from safety_setup import validate_active_classifier_setup
        await validate_active_classifier_setup(db, model=value)
        await db.execute(
            """INSERT INTO app_settings (key, value, updated_at)
               VALUES (?, ?, datetime('now'))
               ON CONFLICT(key) DO UPDATE SET
                 value = excluded.value, updated_at = excluded.updated_at""",
            (SAFETY_CLASSIFIER_SETTING, value),
        )
        await db.commit()
        return value


async def store_model_providers(db, providers: object) -> list[dict]:
    from declarative_cli_profiles import (
        DeclarativeCLIProfileError,
        load_declarative_cli_profiles,
    )
    async with model_registry_write_guard():
        try:
            await load_declarative_cli_profiles(db)
        except DeclarativeCLIProfileError as exc:
            raise ModelProviderError(str(exc), code=exc.code) from exc
        normalized = validate_model_providers(providers)
        await validate_effective_safety_classifier_latency(db, normalized)
        from safety_setup import validate_active_classifier_setup
        await validate_active_classifier_setup(db, providers=normalized)
        from cli_profiles import PROFILES
        from llm_router import _resolve_profile_binary
        for provider in normalized:
            if provider["kind"] != "cli" or not provider["enabled"]:
                continue
            profile = PROFILES[provider["id"]]
            binary, tried = _resolve_profile_binary(profile)
            if binary is None:
                attempted = ", ".join(tried) or profile.binary
                raise ModelProviderError(
                    f"CLI provider '{provider['id']}' cannot be enabled because no binary "
                    f"resolved ({attempted})",
                    code="cli_binary_missing",
                )
        encoded = json.dumps(normalized, ensure_ascii=False, separators=(",", ":"))
        await db.execute(
            """INSERT INTO app_settings (key, value, updated_at)
               VALUES (?, ?, datetime('now'))
               ON CONFLICT(key) DO UPDATE SET
                 value = excluded.value, updated_at = excluded.updated_at""",
            (MODEL_PROVIDERS_SETTING, encoded),
        )
        await db.commit()
        return normalized


async def add_declarative_cli_profile(db, raw_profile: object) -> dict:
    """Persist one new profile and its derived CLI registry entry atomically."""
    from declarative_cli_profiles import (
        DeclarativeCLIProfileError,
        declarative_profile_from_data,
        declarative_profile_to_data,
        load_declarative_cli_profiles,
        replace_declarative_profiles,
        store_declarative_cli_profiles,
    )

    # The duplicate-id check reads the registry and the write appends to what it
    # read: without the guard a concurrent registry PUT is a lost update, and the
    # new CLI entry lands next to a provider set that never saw it.
    async with model_registry_write_guard():
        try:
            existing_profiles = await load_declarative_cli_profiles(db)
            profile = declarative_profile_from_data(raw_profile)
        except DeclarativeCLIProfileError as exc:
            raise ModelProviderError(str(exc), code=exc.code) from exc

        providers = await load_model_providers(db)
        if any(item["id"] == profile.id for item in providers):
            raise ModelProviderError(
                f"provider or CLI profile '{profile.id}' already exists",
                code="duplicate_provider",
            )

        values = [
            declarative_profile_to_data(item) for item in existing_profiles
        ] + [declarative_profile_to_data(profile)]
        try:
            await store_declarative_cli_profiles(db, values)
            registry = await store_model_providers(
                db, [*providers, cli_provider_from_profile(profile)]
            )
        except DeclarativeCLIProfileError as exc:
            replace_declarative_profiles(existing_profiles)
            raise ModelProviderError(str(exc), code=exc.code) from exc
        except ModelProviderError:
            replace_declarative_profiles(existing_profiles)
            raise

        return {
            "profile": declarative_profile_to_data(profile),
            "provider": next(item for item in registry if item["id"] == profile.id),
        }


async def seed_and_migrate_model_providers(db) -> dict:
    """Seed the registry and migrate persisted consumers to the current shape.

    Under the same guard as the API writes: this is a read-modify-write over both
    ``model_providers`` and ``safety_classifier_model``, and it is what decides
    what an accepted config MEANS after a restart.
    """
    async with model_registry_write_guard():
        return await _seed_and_migrate_model_providers(db)


async def _seed_and_migrate_model_providers(db) -> dict:
    from declarative_cli_profiles import (
        DeclarativeCLIProfileError,
        load_declarative_cli_profiles,
    )
    try:
        await load_declarative_cli_profiles(db)
    except DeclarativeCLIProfileError as exc:
        raise ModelProviderError(str(exc), code=exc.code) from exc
    defaults = default_model_providers()
    encoded = json.dumps(defaults, ensure_ascii=False, separators=(",", ":"))
    seed_cur = await db.execute(
        "INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)",
        (MODEL_PROVIDERS_SETTING, encoded),
    )

    family_marker = "_migr_model_provider_cli_family_v1"
    marker_cur = await db.execute(
        "SELECT 1 FROM app_settings WHERE key = ?",
        (family_marker,),
    )
    cli_family_migration_pending = await marker_cur.fetchone() is None
    vision_marker = "_migr_model_provider_vision_transport_v1"
    vision_marker_cur = await db.execute(
        "SELECT 1 FROM app_settings WHERE key = ?",
        (vision_marker,),
    )
    vision_transport_migration_pending = await vision_marker_cur.fetchone() is None
    cli_vision_marker = "_migr_model_provider_cli_vision_profiles_v2"
    cli_vision_marker_cur = await db.execute(
        "SELECT 1 FROM app_settings WHERE key = ?",
        (cli_vision_marker,),
    )
    cli_vision_migration_pending = await cli_vision_marker_cur.fetchone() is None
    cerebras_marker = "_migr_model_provider_cerebras_candidate_v1"
    cerebras_marker_cur = await db.execute(
        "SELECT 1 FROM app_settings WHERE key = ?",
        (cerebras_marker,),
    )
    cerebras_migration_pending = await cerebras_marker_cur.fetchone() is None
    classifier_timeout_marker = "_migr_model_provider_classifier_timeout_v1"
    classifier_timeout_cur = await db.execute(
        "SELECT 1 FROM app_settings WHERE key = ?",
        (classifier_timeout_marker,),
    )
    classifier_timeout_migration_pending = (
        await classifier_timeout_cur.fetchone() is None
    )
    registry_entries_migrated = 0
    cli_providers_seeded = 0
    cerebras_candidates_enabled = 0
    classifier_timeouts_raised = 0
    registry_cur = await db.execute(
        "SELECT value FROM app_settings WHERE key = ?",
        (MODEL_PROVIDERS_SETTING,),
    )
    registry_row = await registry_cur.fetchone()
    try:
        stored_registry = json.loads(registry_row["value"]) if registry_row else None
    except (TypeError, json.JSONDecodeError):
        stored_registry = None
    if isinstance(stored_registry, list):
        changed = False
        if cli_family_migration_pending:
            # ``gemini`` was the API provider before the Gemini CLI joined the
            # family. Move that stored identity once; runtime has no alias.
            for raw in stored_registry:
                if (
                    isinstance(raw, dict)
                    and raw.get("id") == "gemini"
                    and raw.get("kind") == "gemini_api"
                ):
                    raw["id"] = GEMINI_API_PROVIDER_ID
                    raw["api_key_setting"] = "api_key_gemini_api"
                    changed = True

            existing_ids = {
                raw.get("id") for raw in stored_registry
                if isinstance(raw, dict) and isinstance(raw.get("id"), str)
            }
            for provider in defaults:
                if provider["kind"] == "cli" and provider["id"] not in existing_ids:
                    stored_registry.append(copy.deepcopy(provider))
                    existing_ids.add(provider["id"])
                    cli_providers_seeded += 1
                    changed = True

        if classifier_timeout_migration_pending:
            # Databases seeded before SAFETY_CLASSIFIER_PROVIDER_TIMEOUT_MS existed
            # still declare the old 1500ms, which is BELOW the measured p95 of a
            # real classifier call — the gate then fails closed on ordinary
            # traffic. Shipping a new default does not reach them, so move the
            # stored row once. Only the untouched old default value is moved: an
            # operator who already tuned this timeout keeps their number.
            for raw in stored_registry:
                if (
                    isinstance(raw, dict)
                    and raw.get("id") == GEMINI_API_PROVIDER_ID
                    and raw.get("kind") == "gemini_api"
                    and raw.get("timeout_ms") == 1500
                ):
                    raw["timeout_ms"] = SAFETY_CLASSIFIER_PROVIDER_TIMEOUT_MS
                    classifier_timeouts_raised += 1
                    changed = True

        if cerebras_migration_pending:
            # Make cerebras a SELECTABLE classifier candidate on databases seeded
            # before it was one. Only the untouched default shape is enabled: a
            # custom base_url, a widened timeout, or an entry the operator already
            # disabled after this migration ran is left exactly as found (the
            # marker below makes it a one-time move).
            cerebras_default = next(
                (provider for provider in defaults if provider["id"] == "cerebras"),
                None,
            )
            stored_cerebras = next(
                (raw for raw in stored_registry
                 if isinstance(raw, dict) and raw.get("id") == "cerebras"),
                None,
            )
            if cerebras_default is not None and stored_cerebras is None:
                stored_registry.append(copy.deepcopy(cerebras_default))
                cerebras_candidates_enabled += 1
                changed = True
            elif (
                stored_cerebras is not None
                and not stored_cerebras.get("enabled")
                and stored_cerebras.get("kind") == "openai_compatible"
                and str(stored_cerebras.get("base_url") or "").startswith(
                    "https://api.cerebras.ai")
                and isinstance(stored_cerebras.get("timeout_ms"), int)
                and stored_cerebras["timeout_ms"] <= SAFETY_CLASSIFIER_TIMEOUT_MS
            ):
                stored_cerebras["enabled"] = True
                cerebras_candidates_enabled += 1
                changed = True

        provider_ids = {
            raw.get("id") for raw in stored_registry
            if isinstance(raw, dict) and isinstance(raw.get("id"), str)
        }
        cli_defaults = {
            provider["id"]: provider
            for provider in defaults
            if provider["kind"] == "cli"
        }
        for raw in stored_registry:
            if not isinstance(raw, dict):
                continue
            entry_changed = False
            if "capabilities" not in raw:
                raw["capabilities"] = ["json"]
                entry_changed = True
            if (
                vision_transport_migration_pending
                and isinstance(raw.get("capabilities"), list)
            ):
                capabilities = raw["capabilities"]
                if (
                    raw.get("id") == GEMINI_API_PROVIDER_ID
                    and raw.get("kind") == "gemini_api"
                    and "vision" not in capabilities
                ):
                    capabilities.append("vision")
                    entry_changed = True
                if (
                    raw.get("kind") not in VISION_TRANSPORT_KINDS
                    and "vision" in capabilities
                ):
                    raw["capabilities"] = [
                        capability
                        for capability in capabilities
                        if capability != "vision"
                    ]
                    entry_changed = True
            if (
                cli_vision_migration_pending
                and raw.get("kind") == "cli"
                and raw.get("id") in cli_defaults
                and isinstance(raw.get("capabilities"), list)
            ):
                capabilities = raw["capabilities"]
                verified = "vision" in cli_defaults[raw["id"]]["capabilities"]
                if verified and "vision" not in capabilities:
                    capabilities.append("vision")
                    entry_changed = True
                elif not verified and "vision" in capabilities:
                    raw["capabilities"] = [
                        capability
                        for capability in capabilities
                        if capability != "vision"
                    ]
                    entry_changed = True
            if "fallback" not in raw:
                raw["fallback"] = (
                    [
                        candidate
                        for candidate in (GEMINI_API_PROVIDER_ID, "claude")
                        if candidate in provider_ids
                    ]
                    if raw.get("id") == "ollama"
                    else []
                )
                entry_changed = True
            elif cli_family_migration_pending and isinstance(raw["fallback"], list):
                migrated_fallback = [
                    GEMINI_API_PROVIDER_ID if item == "gemini" else item
                    for item in raw["fallback"]
                ]
                if migrated_fallback != raw["fallback"]:
                    raw["fallback"] = migrated_fallback
                    entry_changed = True
            if (
                cli_family_migration_pending
                and raw.get("kind") == "cli"
                and raw.get("id") in cli_defaults
                and raw.get("timeout_ms") == 1500
            ):
                default_cli = cli_defaults[raw["id"]]
                raw["timeout_ms"] = CLI_PROVIDER_TIMEOUT_MS
                raw["enabled"] = default_cli["enabled"]
                entry_changed = True
            if entry_changed:
                registry_entries_migrated += 1
                changed = True
        if changed:
            await db.execute(
                """UPDATE app_settings SET value = ?, updated_at = datetime('now')
                   WHERE key = ?""",
                (
                    json.dumps(stored_registry, ensure_ascii=False, separators=(",", ":")),
                    MODEL_PROVIDERS_SETTING,
                ),
            )
    providers = await load_model_providers(db)

    workspace_model_migrations = WorkspaceModelMigrations()
    research_models_migrated = 0
    research_urls_cleared = 0
    workspace_columns_cur = await db.execute("PRAGMA table_info(workspaces)")
    workspace_columns = {
        row["name"] for row in await workspace_columns_cur.fetchall()
    }
    if "research_model" in workspace_columns:
        rows_cur = await db.execute(
            "SELECT * FROM workspaces"
        )
        provider_ids = {provider["id"] for provider in providers}

        for row in await rows_cur.fetchall():
            research_model = qualify_model(
                row["research_model"],
                provider_ids,
                migrate_gemini_api_alias=cli_family_migration_pending,
            )
            if research_model is not None and row["research_model"] != research_model:
                await db.execute(
                    "UPDATE workspaces SET research_model = ? WHERE id = ?",
                    (research_model, row["id"]),
                )
                research_models_migrated += 1

            await workspace_model_migrations.migrate_row(
                db, row,
                qualify_model=qualify_model,
                provider_ids=provider_ids,
                research_model=research_model,
                migrate_gemini_api_alias=cli_family_migration_pending,
            )

        if "research_llm_url" in workspace_columns:
            url_cur = await db.execute(
                """UPDATE workspaces SET research_llm_url = NULL
                   WHERE COALESCE(research_llm_url, '') != ''"""
            )
            research_urls_cleared = max(url_cur.rowcount, 0)

    setting_placeholders = ",".join("?" for _ in _QUALIFIED_MODEL_SETTING_KEYS)
    settings_cur = await db.execute(
        f"SELECT key, value FROM app_settings WHERE key IN ({setting_placeholders})",
        _QUALIFIED_MODEL_SETTING_KEYS,
    )
    model_values_migrated = 0
    catchup_models_migrated = 0
    safety_classifier_resets = 0
    provider_ids = {provider["id"] for provider in providers}
    for row in await settings_cur.fetchall():
        migrated = qualify_model(
            row["value"],
            provider_ids,
            migrate_gemini_api_alias=cli_family_migration_pending,
        )
        if row["key"] == SAFETY_CLASSIFIER_SETTING:
            # THE ONE WRITE PATH THAT USED TO BYPASS THE LATENCY GATE. qualify_model's
            # last-resort inference is ``claude:{raw}`` — a CLI provider — so a legacy
            # bare value like "haiku" was silently rewritten to exactly the config
            # PUT /api/settings/safety_classifier_model rejects with
            # safety_classifier_latency_budget_exceeded, putting a subprocess cold
            # start in front of EVERY tool call. Validate the value this migration is
            # about to leave behind (the rewritten one, or the stored one when there is
            # nothing to rewrite) and fall back to the seeded default when it cannot
            # meet the budget. Loud, counted, and never silently kept.
            effective = migrated or (row["value"] or "")
            try:
                validate_safety_classifier_latency(providers, effective)
            except ModelProviderError as exc:
                logger.warning(
                    "safety classifier %r cannot meet the %dms gate budget (%s) — "
                    "resetting to %s",
                    effective, SAFETY_CLASSIFIER_TIMEOUT_MS, exc.code,
                    DEFAULT_SAFETY_CLASSIFIER_MODEL,
                )
                migrated = DEFAULT_SAFETY_CLASSIFIER_MODEL
                safety_classifier_resets += 1
        if migrated is None or migrated == row["value"]:
            continue
        await db.execute(
            """UPDATE app_settings SET value = ?, updated_at = datetime('now')
               WHERE key = ?""",
            (migrated, row["key"]),
        )
        model_values_migrated += 1
        if row["key"] == "catchup_model":
            catchup_models_migrated += 1
    # The old general Google key powered this path. Copy it once into the new
    # provider-owned setting; runtime resolution uses only the new contract.
    key_cur = await db.execute(
        """INSERT OR IGNORE INTO app_settings (key, value)
           SELECT 'api_key_gemini_api', value FROM app_settings
           WHERE key IN ('api_key_gemini', 'api_key_google')
             AND COALESCE(value, '') != ''
             AND NOT EXISTS (
               SELECT 1 FROM app_settings
               WHERE key = '_migr_model_provider_gemini_api_key_v1'
             )
           ORDER BY CASE key WHEN 'api_key_gemini' THEN 0 ELSE 1 END
           LIMIT 1"""
    )
    await db.execute(
        "INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, 'done')",
        ("_migr_model_provider_gemini_api_key_v1",),
    )
    family_cur = await db.execute(
        "INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, 'done')",
        (family_marker,),
    )
    vision_cur = await db.execute(
        "INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, 'done')",
        (vision_marker,),
    )
    cli_vision_cur = await db.execute(
        "INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, 'done')",
        (cli_vision_marker,),
    )
    await db.execute(
        "INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, 'done')",
        (cerebras_marker,),
    )
    await db.execute(
        "INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, 'done')",
        (classifier_timeout_marker,),
    )
    return {
        "registry_seeded": max(seed_cur.rowcount, 0),
        "registry_entries_migrated": registry_entries_migrated,
        "cli_providers_seeded": cli_providers_seeded,
        "cerebras_candidates_enabled": cerebras_candidates_enabled,
        "classifier_timeouts_raised": classifier_timeouts_raised,
        "safety_classifier_resets": safety_classifier_resets,
        "cli_family_migrated": max(family_cur.rowcount, 0),
        "vision_transport_migrated": max(vision_cur.rowcount, 0),
        "cli_vision_profiles_migrated": max(cli_vision_cur.rowcount, 0),
        "model_values_migrated": model_values_migrated,
        **workspace_model_migrations.counts,
        "research_models_migrated": research_models_migrated,
        "research_urls_cleared": research_urls_cleared,
        "catchup_models_migrated": catchup_models_migrated,
        "gemini_keys_migrated": max(key_cur.rowcount, 0),
    }


def mask_api_key(value: str | None) -> str | None:
    if not value:
        return None
    return value[:8] + "..." + value[-4:] if len(value) > 12 else "***"
