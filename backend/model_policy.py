"""An agent's model choices stay inside the user's explicit configuration."""
from __future__ import annotations


async def switching_enabled(db) -> bool:
    row = await (await db.execute(
        "SELECT value FROM app_settings WHERE key = 'experimental_model_switching'"
    )).fetchone()
    return bool(row and row['value'] == 'on')


def switch_error(config: dict, model: str, enabled: bool) -> str | None:
    if model == config.get('model'):
        return None
    allowed = {config.get('model')}
    if enabled:
        allowed.update((config.get('plan_model'), config.get('execute_model')))
    if model and model in allowed:
        return None
    return 'The model is fixed by the user. Choose it in IVE, or explicitly configure plan/execute models in Dual Model Switching.'


async def migrate_model_switching(db) -> None:
    # Earlier installs seeded this costly capability ON without user consent.
    # Preserve an actual two-model configuration; repair the unconfigured default.
    key = '_migr_model_switching_opt_in_v1'
    if await (await db.execute('SELECT value FROM app_settings WHERE key = ?', (key,))).fetchone():
        return
    configured = await (await db.execute(
        "SELECT 1 FROM sessions WHERE COALESCE(plan_model, '') != '' AND COALESCE(execute_model, '') != '' LIMIT 1"
    )).fetchone()
    if not configured:
        await db.execute("UPDATE app_settings SET value = 'off' WHERE key = 'experimental_model_switching'")
    await db.execute('INSERT INTO app_settings (key, value) VALUES (?, ?)', (key, 'done'))
