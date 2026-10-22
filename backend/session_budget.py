"""Bounded, read-only context telemetry. Never sum a conversation's usage."""
from __future__ import annotations

import json
import math
from runtime_model import _tail_lines

COMPACT_WINDOW = 200_000
WARN_TOKENS = 150_000


def read_context_usage(path) -> dict | None:
    if not path:
        return None
    try:
        lines = _tail_lines(str(path), 2 * 1024 * 1024)
    except OSError:
        return None
    for line in reversed(lines):
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if not isinstance(rec, dict):
            continue
        if rec.get('type') == 'system' and rec.get('subtype') == 'compact_boundary':
            return None  # pre-compaction usage is no longer current
        payload = rec.get('payload') or {}
        if not isinstance(payload, dict):
            payload = {}
        if payload.get('type') == 'context_compacted':
            return None
        usage = None
        if rec.get('type') == 'assistant':
            message = rec.get('message') or {}
            if isinstance(message, dict) and message.get('model') != '<synthetic>':
                usage = message.get('usage')
                fields = ('input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens')
        elif rec.get('type') == 'event_msg' and payload.get('type') == 'token_count':
            info = payload.get('info') or {}
            if isinstance(info, dict):
                usage = info.get('last_token_usage')
                fields = ('input_tokens',)  # cached_input_tokens is already included
        if not isinstance(usage, dict):
            continue
        values = [usage.get(k, 0) for k in fields]
        if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v >= 0 for v in values):
            continue
        tokens = int(sum(values))
        if tokens <= 0:
            continue
        return {'input_tokens': tokens, 'warning': tokens >= WARN_TOKENS,
                'warning_tokens': WARN_TOKENS, 'at': rec.get('timestamp'),
                'source': 'last_request', 'includes_cached_tokens': True}
    return None


def claude_compaction_env() -> dict[str, str]:
    """Launch-only budget: leave the user's global CLI settings untouched."""
    return {'CLAUDE_CODE_AUTO_COMPACT_WINDOW': str(COMPACT_WINDOW),
            'DISABLE_AUTO_COMPACT': '0', 'DISABLE_COMPACT': '0'}
