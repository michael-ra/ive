"""Standalone tests for code_catalog_parser.

Run with:  python backend/code_catalog_parser_test.py
Exits 0 on pass, 1 on any failure. No pytest dependency.
"""

import random
import string
import sys
import traceback

from code_catalog_parser import (
    parse_line,
    emit_line,
    infer_kind,
    normalized_eq,
    dense_text,
    empty_parsed,
)


_results: list[tuple[str, bool, str]] = []


def case(name):
    def deco(fn):
        try:
            fn()
            _results.append((name, True, ''))
        except AssertionError as e:
            _results.append((name, False, f'{e}\n{traceback.format_exc()}'))
        except Exception as e:
            _results.append((name, False, f'unexpected: {e}\n{traceback.format_exc()}'))
        return fn
    return deco


# ── parse_line: well-formed cases ────────────────────────────────────────

@case('parse: minimal line')
def _():
    p = parse_line('x.py::foo(): does X')
    assert p['symbol_file'] == 'x.py', p
    assert p['symbol_name'] == 'foo'
    assert p['args'] == ''
    assert p['purpose'] == 'does X'
    assert p['flow'] == []
    assert p['effects'] == []


@case('parse: with args')
def _():
    p = parse_line('backend/server.py::create_app(): registers routes')
    assert p['symbol_file'] == 'backend/server.py'
    assert p['symbol_name'] == 'create_app'
    assert p['args'] == ''
    assert p['purpose'] == 'registers routes'


@case('parse: signature with args')
def _():
    p = parse_line('a/b.py::do_thing(x, y, z): returns sum')
    assert p['args'] == 'x, y, z', p
    assert p['purpose'] == 'returns sum'


@case('parse: args with type annotations and brackets')
def _():
    p = parse_line('a/b.py::run(workspace_id: str, defn: dict): kicks pipeline')
    assert p['symbol_name'] == 'run'
    assert p['args'] == 'workspace_id: str, defn: dict'
    assert p['purpose'] == 'kicks pipeline'


@case('parse: nested generic bracket in args')
def _():
    p = parse_line('a/b.py::merge(a: dict[str, int]): merges')
    assert p['symbol_name'] == 'merge'
    assert p['args'] == 'a: dict[str, int]'


@case('parse: Class.method dotted symbol')
def _():
    p = parse_line('backend/foo.py::Foo.bar(self, x): does Y')
    assert p['symbol_name'] == 'Foo.bar'
    assert p['args'] == 'self, x'
    assert p['symbol_kind'] == 'method'


@case('parse: flow tokens with pipe')
def _():
    p = parse_line('a.py::foo(): does X | →dep1 ←caller1 ↔shared1')
    assert p['purpose'] == 'does X', p['purpose']
    kinds = [(f['kind'], f['target']) for f in p['flow']]
    assert ('out', 'dep1') in kinds
    assert ('in', 'caller1') in kinds
    assert ('bidir', 'shared1') in kinds


@case('parse: flow tokens without pipe (inline in body)')
def _():
    p = parse_line('a.py::foo(): →dep1 something')
    targets = [f['target'] for f in p['flow']]
    assert 'dep1' in targets


@case('parse: effects')
def _():
    p = parse_line('a.py::foo(): does X ◆writes table ◆emits event')
    assert p['purpose'] == 'does X'
    assert p['effects'] == ['writes table', 'emits event'], p['effects']


@case('parse: flow + effects together')
def _():
    p = parse_line('a.py::foo(): does X | →d1 ←c1 ◆writes ◆emits e')
    assert p['purpose'] == 'does X'
    targets = [f['target'] for f in p['flow']]
    assert 'd1' in targets and 'c1' in targets
    assert 'writes' in p['effects']
    assert 'emits e' in p['effects']


@case('parse: tolerates surrounding markdown backticks')
def _():
    p = parse_line('`a.py::foo(): does X`')
    assert p['symbol_name'] == 'foo', p


@case('parse: tolerates leading bullet')
def _():
    p = parse_line('- a.py::foo(): does X')
    assert p['symbol_name'] == 'foo', p


@case('parse: pipe inside prose (no flow after) is kept as prose')
def _():
    # If `|` isn't followed by flow tokens, it's prose.
    p = parse_line('a.py::foo(): handles X | Y | Z scenarios')
    assert 'X | Y | Z' in p['purpose'], p['purpose']
    assert p['flow'] == []


@case('parse: arrow used in prose with valid target still extracts flow')
def _():
    # By design: any →target in body is a flow token. Authors should
    # avoid using `→` in prose if they don't mean flow.
    p = parse_line('a.py::foo(): walks state →target_node')
    assert any(f['target'] == 'target_node' for f in p['flow'])


# ── parse_line: malformed / loose-mode ───────────────────────────────────

@case('parse: empty string')
def _():
    p = parse_line('')
    assert p['symbol_name'] is None
    assert p['raw'] == ''


@case('parse: None input')
def _():
    p = parse_line(None)
    assert p['symbol_name'] is None
    assert p['raw'] == ''


@case('parse: unparseable preserves raw')
def _():
    raw = 'this is not a catalog line'
    p = parse_line(raw)
    assert p['symbol_name'] is None
    assert p['raw'] == raw


@case('parse: missing colon')
def _():
    p = parse_line('a.py::foo() no colon')
    assert p['symbol_name'] is None


@case('parse: strict mode raises')
def _():
    try:
        parse_line('garbage', strict=True)
    except ValueError:
        return
    assert False, 'expected ValueError'


# ── infer_kind heuristics ────────────────────────────────────────────────

@case('infer_kind: function default')
def _():
    assert infer_kind('a.py', 'foo') == 'function'


@case('infer_kind: method via dot')
def _():
    assert infer_kind('a.py', 'Foo.bar') == 'method'


@case('infer_kind: SCREAMING_CASE event')
def _():
    assert infer_kind('a.py', 'TASK_COMPLETED') == 'event'


@case('infer_kind: sql query')
def _():
    assert infer_kind('q/x.sql', 'fetch_all') == 'query'


@case('infer_kind: tsx component (Pascal)')
def _():
    assert infer_kind('src/X.tsx', 'KnowledgePanel') == 'component'


@case('infer_kind: tsx hook (useFoo)')
def _():
    assert infer_kind('src/X.tsx', 'useFoo') == 'hook'


@case('infer_kind: tsx lowercase function')
def _():
    assert infer_kind('src/x.tsx', 'helperFn') == 'function'


@case('infer_kind: ts type (Pascal)')
def _():
    assert infer_kind('src/types.ts', 'UserProfile') == 'type'


@case('infer_kind: empty file falls back to function')
def _():
    assert infer_kind('', '') == 'function'


# ── emit_line + roundtrip ────────────────────────────────────────────────

@case('emit: minimal')
def _():
    s = emit_line('a.py', 'foo', '', 'does X')
    assert s == 'a.py::foo(): does X', s


@case('emit: with flow + effects')
def _():
    s = emit_line('a.py', 'foo', 'x', 'does X',
                  flow=[{'kind': 'out', 'target': 'd1'},
                        {'kind': 'in', 'target': 'c1'}],
                  effects=['writes table', 'emits event'])
    assert '→d1' in s and '←c1' in s
    assert '◆writes table' in s and '◆emits event' in s


def _flow_set(flow):
    return frozenset((f['kind'], f['target']) for f in flow)


@case('roundtrip: parse(emit) preserves identity for simple cases')
def _():
    original = 'a.py::foo(x): does X | →d1 ←c1 ◆writes'
    p1 = parse_line(original)
    re_emitted = emit_line(p1['symbol_file'], p1['symbol_name'], p1['args'],
                            p1['purpose'], p1['flow'], p1['effects'])
    p2 = parse_line(re_emitted)
    assert p1['symbol_name'] == p2['symbol_name']
    assert p1['symbol_file'] == p2['symbol_file']
    assert p1['args'] == p2['args']
    assert p1['purpose'] == p2['purpose']
    assert _flow_set(p1['flow']) == _flow_set(p2['flow'])
    assert sorted(p1['effects']) == sorted(p2['effects'])


# ── normalized_eq ────────────────────────────────────────────────────────

@case('normalized_eq: identical strings')
def _():
    a = b = 'a.py::foo(): does X'
    assert normalized_eq(a, b)


@case('normalized_eq: whitespace differences')
def _():
    a = 'a.py::foo(): does X'
    b = 'a.py::foo():   does    X'
    assert normalized_eq(a, b)


@case('normalized_eq: flow token order')
def _():
    a = 'a.py::foo(): X | →d1 →d2'
    b = 'a.py::foo(): X | →d2 →d1'
    assert normalized_eq(a, b)


@case('normalized_eq: different purpose returns False')
def _():
    a = 'a.py::foo(): X'
    b = 'a.py::foo(): Y'
    assert not normalized_eq(a, b)


@case('normalized_eq: different symbol returns False')
def _():
    a = 'a.py::foo(): X'
    b = 'a.py::bar(): X'
    assert not normalized_eq(a, b)


@case('normalized_eq: case-insensitive purpose')
def _():
    a = 'a.py::foo(): Does X'
    b = 'a.py::foo(): does x'
    assert normalized_eq(a, b)


# ── dense_text ───────────────────────────────────────────────────────────

@case('dense_text: name + purpose')
def _():
    p = parse_line('a.py::foo(): does X | →d1 ◆writes')
    t = dense_text(p)
    assert t == 'foo: does X', t
    # flow / effects intentionally excluded
    assert 'd1' not in t
    assert 'writes' not in t


@case('dense_text: missing purpose falls to name')
def _():
    t = dense_text({'symbol_name': 'foo', 'purpose': ''})
    assert t == 'foo'


@case('dense_text: empty parsed is empty string')
def _():
    t = dense_text(empty_parsed('garbage'))
    assert t == '', t


# ── fuzz: never-raise property under random inputs ───────────────────────

@case('fuzz: 500 random lines never raise in loose mode')
def _():
    random.seed(0xC0DECA7)
    chars = string.ascii_letters + string.digits + ' :|()→←↔◆.,_/`-\'"<>*#@'
    for _i in range(500):
        n = random.randint(0, 200)
        raw = ''.join(random.choice(chars) for _ in range(n))
        # must not raise
        parse_line(raw, strict=False)


# ── main ─────────────────────────────────────────────────────────────────

def main() -> int:
    passed = sum(1 for _, ok, _ in _results if ok)
    failed = [(n, msg) for n, ok, msg in _results if not ok]
    total = len(_results)

    for name, ok, _ in _results:
        mark = 'PASS' if ok else 'FAIL'
        print(f'  [{mark}] {name}')
    print()
    print(f'  {passed}/{total} passed, {len(failed)} failed')
    if failed:
        print()
        for n, msg in failed:
            print(f'--- {n} ---')
            print(msg)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
