"""Validate optional AI checks before putting them in front of tool calls.

This is a local configuration check, not a provider request. Once opted in,
runtime failures retain the configured ask/deny behavior.
"""
from model_providers import (
    ModelProviderError, api_key_from_env, effective_safety_classifier_model,
    load_model_providers, validate_safety_classifier_latency,
)

_UNSET = object()


async def classifier_setup(db, *, model=_UNSET, providers=None) -> dict:
    from llm_router import _resolve_model_from_registry

    try:
        if providers is None:
            providers = await load_model_providers(db)
        if model is _UNSET:
            cursor = await db.execute(
                "SELECT value FROM app_settings WHERE key = 'safety_classifier_model'"
            )
            row = await cursor.fetchone()
            model = row["value"] if row else None
        model = effective_safety_classifier_model(providers, model)
        if not model:
            return {"ready": True, "model": "", "issue": None}
        provider, _ = _resolve_model_from_registry(providers, model, required_capability="json")
        validate_safety_classifier_latency(providers, model)
        key = provider.get("api_key_setting")
        if key:
            cursor = await db.execute("SELECT value FROM app_settings WHERE key = ?", (key,))
            row = await cursor.fetchone()
            if not (row and str(row["value"] or "").strip()) and not api_key_from_env(key):
                raise ModelProviderError(
                    f"Configure the API key for {provider['id']} before enabling the optional AI check.",
                    code="provider_not_configured",
                )
    except ModelProviderError as exc:
        return {"ready": False, "model": model if isinstance(model, str) else None, "issue": str(exc), "code": exc.code}
    return {"ready": True, "model": model, "issue": None}


async def migrate_unconfigured_classifier(db) -> None:
    """One-time repair of old installs that auto-enabled a keyless classifier.

    Configured opt-ins and explicit off choices are preserved. This does not turn
    off an opted-in check on subsequent provider outages or key removal.
    """
    marker = "_migr_optional_safety_setup_v1"
    cursor = await db.execute("SELECT 1 FROM app_settings WHERE key = ?", (marker,))
    if await cursor.fetchone():
        return
    cursor = await db.execute(
        "SELECT value FROM app_settings WHERE key = 'experimental_safety_gate'"
    )
    row = await cursor.fetchone()
    if row and row["value"] == "on":
        setup = await classifier_setup(db)
        if not setup["ready"]:
            await db.execute(
                "UPDATE app_settings SET value = 'off', updated_at = datetime('now') "
                "WHERE key = 'experimental_safety_gate'"
            )
    await db.execute("INSERT INTO app_settings (key, value) VALUES (?, 'done')", (marker,))


async def validate_active_classifier_setup(db, **kwargs) -> None:
    cursor = await db.execute(
        "SELECT value FROM app_settings WHERE key = 'experimental_safety_gate'"
    )
    row = await cursor.fetchone()
    if row and row["value"] == "on":
        setup = await classifier_setup(db, **kwargs)
        if not setup["ready"]:
            raise ModelProviderError(setup["issue"], code=setup["code"])
