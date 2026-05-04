"""Code Catalog wire-format parser.

Wire format (one line):
    <file>::<symbol>(<args>?): <body>

<body> is free text that may contain anywhere:
    →<target>  forward dependency / call
    ←<target>  inbound caller / trigger
    ↔<target>  shared state / bidirectional
    ◆<effect>  side effect, runs until next ◆ or end of line

The optional pipe `|` is a soft separator from purpose prose to flow
tokens — only treated as a boundary when a flow token actually follows.

Loose by default: parse_line never raises (unless strict=True). Callers
preserve content even when an LLM emits a malformed line — symbol_name
will be NULL but `raw` is always preserved.
"""

import re


_HEAD_RE = re.compile(
    r'^\s*'
    r'(?P<file>[^\s:][^\s]*?)'
    r'::'
    r'(?P<symbol>[A-Za-z_][\w.]*)'
    r'\((?P<args>.*?)\)'
    r'(?:\s*->\s*[^:\n]+?)?'
    r'\s*:\s*'
    r'(?P<body>.*)$',
)

_FLOW_TOKEN_RE = re.compile(r'([→←↔])\s*([^\s→←↔◆|()`,;]+)')
_EFFECT_RE = re.compile(r'◆\s*([^◆]+?)(?=◆|$)', re.DOTALL)
_PIPE_RE = re.compile(r'\|')

_FLOW_KIND_MAP = {'→': 'out', '←': 'in', '↔': 'bidir'}
_FLOW_KIND_REVERSE = {'out': '→', 'in': '←', 'bidir': '↔'}

_SCREAMING_RE = re.compile(r'^[A-Z_][A-Z0-9_]+$')
_PASCAL_RE = re.compile(r'^[A-Z][A-Za-z0-9]*$')


def empty_parsed(raw: str = '') -> dict:
    return {
        'symbol_file': None,
        'symbol_name': None,
        'symbol_kind': None,
        'args': None,
        'purpose': None,
        'flow': [],
        'effects': [],
        'raw': raw,
    }


def parse_line(raw, *, strict: bool = False) -> dict:
    """Parse a catalog line into structured fields.

    On loose mode (default), returns empty_parsed(raw) when the leading
    <file>::<symbol>(...) shape can't be extracted, so callers never
    lose content.
    """
    if raw is None:
        if strict:
            raise ValueError('raw is None')
        return empty_parsed('')
    line = raw.rstrip('\n').strip()
    # Tolerate markdown wrapping around the line (e.g. backtick fences).
    line = line.strip('`').strip()
    # Tolerate a leading "- " bullet from copy-paste of CODE_CATALOG.md.
    if line.startswith('- '):
        line = line[2:].strip()
    line = line.strip('`').strip()

    m = _HEAD_RE.match(line)
    if not m:
        if strict:
            raise ValueError(f'unparseable: {line!r}')
        return empty_parsed(raw)

    file = m.group('file')
    symbol = m.group('symbol')
    args = (m.group('args') or '').strip()
    body = m.group('body') or ''

    boundary = _purpose_boundary(body)
    purpose = body[:boundary].strip().rstrip('|').strip()

    flow: list[dict] = []
    for m_flow in _FLOW_TOKEN_RE.finditer(body):
        flow.append({
            'kind': _FLOW_KIND_MAP[m_flow.group(1)],
            'glyph': m_flow.group(1),
            'target': m_flow.group(2),
        })

    effects: list[str] = []
    if '◆' in body:
        # Re-find from first ◆ to capture all effect chunks correctly.
        first = body.index('◆')
        for m_eff in _EFFECT_RE.finditer(body[first:]):
            text = m_eff.group(1).strip()
            if text:
                effects.append(text)

    return {
        'symbol_file': file,
        'symbol_name': symbol,
        'symbol_kind': infer_kind(file, symbol),
        'args': args,
        'purpose': purpose,
        'flow': flow,
        'effects': effects,
        'raw': raw,
    }


def emit_line(
    file: str,
    symbol: str,
    args: str = '',
    purpose: str = '',
    flow=None,
    effects=None,
) -> str:
    """Build a canonical wire-format line from structured fields."""
    args = (args or '').strip()
    head = f'{file}::{symbol}({args}): {(purpose or "").strip()}'.rstrip()
    parts = [head]
    if flow:
        flow_str = ' '.join(
            f'{f.get("glyph") or _FLOW_KIND_REVERSE.get(f.get("kind"), "→")}{f["target"]}'
            for f in flow if f.get('target')
        )
        if flow_str:
            parts.append('| ' + flow_str)
    if effects:
        for eff in effects:
            t = (eff or '').strip()
            if t:
                parts.append('◆' + t)
    return ' '.join(parts)


def infer_kind(file: str, symbol: str) -> str:
    """Best-effort symbol kind from filename + symbol shape.

    Heuristic-only — emitters can override on insert via parsed['symbol_kind']
    if they have stronger context (AST, tree-sitter, etc.).
    """
    if not file or not symbol:
        return 'function'
    file_l = file.lower()

    if file_l.endswith('.sql'):
        return 'query'

    base = symbol.split('.')[0]

    if '.' in symbol:
        return 'method'

    if _SCREAMING_RE.match(symbol):
        return 'event'

    if file_l.endswith(('.tsx', '.jsx')):
        if base.startswith('use') and len(base) > 3 and base[3].isupper():
            return 'hook'
        if _PASCAL_RE.match(base):
            return 'component'
        return 'function'

    if file_l.endswith('.ts'):
        if base.startswith('use') and len(base) > 3 and base[3].isupper():
            return 'hook'
        if _PASCAL_RE.match(base):
            return 'type'

    return 'function'


def normalized_eq(a, b) -> bool:
    """True when two raw lines describe the same symbol with the same content,
    ignoring whitespace and flow-token order."""
    if a == b:
        return True
    pa = parse_line(a, strict=False)
    pb = parse_line(b, strict=False)
    if pa['symbol_name'] is None or pb['symbol_name'] is None:
        return _norm(a) == _norm(b)
    return (
        pa['symbol_file'] == pb['symbol_file']
        and pa['symbol_name'] == pb['symbol_name']
        and _norm(pa['args'] or '') == _norm(pb['args'] or '')
        and _norm(pa['purpose'] or '') == _norm(pb['purpose'] or '')
        and _flow_set(pa['flow']) == _flow_set(pb['flow'])
        and sorted(_norm(e) for e in pa['effects'])
            == sorted(_norm(e) for e in pb['effects'])
    )


def dense_text(parsed: dict) -> str:
    """Embedding input for a parsed catalog line.

    Excludes flow/effects so semantic search hits the *concept* of what
    a function does, not call-graph noise.
    """
    name = (parsed.get('symbol_name') or '').strip()
    purpose = (parsed.get('purpose') or '').strip()
    if name and purpose:
        return f'{name}: {purpose}'
    return name or purpose


def _norm(s) -> str:
    return ' '.join((s or '').lower().split())


def _flow_set(flow):
    return frozenset((f['kind'], f['target']) for f in flow if f.get('target'))


def _purpose_boundary(body: str) -> int:
    """Earliest index in `body` where flow tokens / effects / soft separator begin."""
    candidates: list[int] = []
    first_flow = _FLOW_TOKEN_RE.search(body)
    if first_flow:
        candidates.append(first_flow.start())
    if '◆' in body:
        candidates.append(body.index('◆'))
    # `|` only counts as separator if followed by a flow token somewhere later.
    for m in _PIPE_RE.finditer(body):
        idx = m.start()
        if _FLOW_TOKEN_RE.search(body[idx + 1:]):
            candidates.append(idx)
            break
    return min(candidates) if candidates else len(body)
