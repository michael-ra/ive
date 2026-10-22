"""Validate the exact run a person reviewed before accepting its task."""
import json


async def validate_result_acceptance(db, task: dict, run_id: str) -> None:
    cursor = await db.execute(
        "SELECT * FROM pipeline_runs WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
        (task['id'],),
    )
    row = await cursor.fetchone()
    if not row or row['id'] != run_id or row['status'] != 'completed' or task['status'] not in ('review', 'done'):
        raise ValueError('The task changed. Review its current result before accepting.')
    cursor = await db.execute(
        "SELECT 1 FROM pipeline_runs WHERE task_id = ? AND status IN ('running', 'paused') LIMIT 1",
        (task['id'],),
    )
    if await cursor.fetchone():
        raise ValueError('A run is still active. Wait for verification before accepting.')
    history = json.loads(row['stage_history'] or '{}')
    verify = history.get('verify') or {}
    if verify.get('status') != 'completed' or not str(verify.get('output_summary') or '').startswith('__pipeline_result:pass:'):
        raise ValueError('A passing verification report is required before accepting.')
