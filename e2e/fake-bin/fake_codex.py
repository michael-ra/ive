#!/usr/bin/env python3
"""Stand-in for `codex` (codex-cli 0.162.1) inside the IVE end-to-end sandbox.

Installed as <sandbox>/bin/codex by e2e/sandbox.mjs. No network, no API key.
It copies the parts of real codex-tui 0.16x that IVE depends on and that
broke before:

  * clap-strict argv: unknown flags, `-a untrusted|on-failure` and bad
    `--sandbox` values print `error: ...` and exit 2, like the real CLI.
  * `resume <SESSION_ID> [PROMPT]`; an unknown id prints an error, exit 1.
  * Lazy rollout: nothing is written at start. The first prompt creates
    $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid7>.jsonl in the 0.16x
    record shape (user turns only as event_msg item_completed UserMessage,
    no event_msg user_message).
  * `spawn <text>` also writes a subagent rollout (same cwd,
    thread_source "subagent", session_id = parent id != id) AFTER the parent
    rollout, so naive "newest file in cwd" detection binds the wrong thread.
  * Workspace trust: when the project (git root, else cwd) has no
    [projects."<path>"] trust_level in $CODEX_HOME/config.toml, the TUI first
    shows codex's "Trust this folder?" menu with "› 1. Trust and continue".
    Typed text is dropped while it is open (logged as "trust menu dropped"),
    Enter/1 accepts and appends the trust entry like real codex.
  * `/new` starts a fresh thread: new id, SessionStart source "clear", lazy
    rollout again (codex-rs SessionStartSource: startup|resume|clear|compact|fork).
  * Hooks come from [[hooks.<Event>]] tables in $CODEX_HOME/config.toml and
    run only when [hooks.state."<path>:<event_snake>:<g>:<h>"].trusted_hash
    equals codex's hash of the handler (path = realpath($CODEX_HOME)/config.toml)
    or with --dangerously-bypass-hook-trust. Codex event set: no
    Notification; PermissionRequest is the "needs you" signal.

Commands typed into the prompt:
  ask <cmd>    -> PermissionRequest hook + approval dialog; "1" approves
  spawn <text> -> normal turn plus a subagent rollout
  slow <text>  -> normal turn that works 6 s instead of 1.5 s
  quit         -> exit 0
  anything     -> one turn: UserPromptSubmit, tool call, reply, Stop
"""
import datetime
import hashlib
import json
import os
import re
import select
import signal
import subprocess
import sys
import termios
import time
import tty
import uuid

try:
    import tomllib  # Python 3.11+
except ImportError:  # the sandbox PATH has /usr/bin/python3 (3.9)
    tomllib = None

VERSION = "0.162.1"
HOME = os.environ.get("HOME", "")
CODEX_HOME = os.environ.get("CODEX_HOME") or os.path.join(HOME, ".codex")
LOG = os.path.join(HOME, "fake-cli.log")
APPROVALS = ("on-request", "never")
SANDBOXES = ("read-only", "workspace-write", "danger-full-access")
VALUE_FLAGS = {
    "-c", "--config", "--enable", "--disable", "--remote", "--remote-auth-token-env",
    "-i", "--image", "-m", "--model", "--local-provider", "-p", "--profile",
    "-s", "--sandbox", "-C", "--cd", "--add-dir", "-a", "--ask-for-approval",
}
BOOL_FLAGS = {
    "--strict-config", "--oss", "--approve-for-me", "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust", "--worktree", "--search", "--no-alt-screen", "--no-daemon",
}
RESUME_BOOL_FLAGS = {"--last", "--all", "--include-non-interactive"}
SUBCOMMANDS = {
    "agents", "exec", "e", "review", "login", "logout", "mcp", "plugin", "app-server",
    "remote-control", "app", "completion", "update", "doctor", "sandbox", "debug", "apply", "a",
    "queue", "archive", "delete", "migrate-rollouts", "unarchive", "fork", "cloud",
    "exec-server", "features", "help",
}


def log(msg):
    try:
        with open(LOG, "a", encoding="utf-8") as fh:
            stamp = time.strftime('%H:%M:%S') + f".{int(time.time() * 1000) % 1000:03d}"
            fh.write(f"{stamp} codex[{os.getpid()}] {msg}\n")
    except OSError:
        pass


def die(msg, code=2):
    sys.stderr.write(f"error: {msg}\n\nFor more information, try '--help'.\n")
    log(f"argv error rc={code}: {msg}")
    sys.exit(code)


def parse_args(argv):
    opts = {"config": [], "add_dir": [], "flags": set(), "approval": None, "sandbox": None,
            "model": None, "resume": False, "resume_id": None, "prompt": None, "sub": None}
    positionals = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg in ("-V", "--version"):
            opts["flags"].add("--version")
            i += 1
            continue
        if arg in ("-h", "--help"):
            opts["flags"].add("--help")
            i += 1
            continue
        if arg.startswith("-") and arg != "-":
            name, eq, inline = arg.partition("=")
            if name in VALUE_FLAGS:
                if eq:
                    value = inline
                elif i + 1 < len(argv):
                    i += 1
                    value = argv[i]
                else:
                    die(f"a value is required for '{name} <VALUE>' but none was supplied")
                if name in ("-a", "--ask-for-approval"):
                    if value not in APPROVALS:
                        die(f"invalid value '{value}' for '--ask-for-approval <APPROVAL_POLICY>'\n"
                            f"  [possible values: {', '.join(APPROVALS)}]")
                    opts["approval"] = value
                elif name in ("-s", "--sandbox"):
                    if value not in SANDBOXES:
                        die(f"invalid value '{value}' for '--sandbox <SANDBOX_MODE>'\n"
                            f"  [possible values: {', '.join(SANDBOXES)}]")
                    opts["sandbox"] = value
                elif name in ("-c", "--config"):
                    if "=" not in value:
                        die(f"invalid value '{value}' for '--config <key=value>'")
                    opts["config"].append(value)
                elif name in ("-m", "--model"):
                    opts["model"] = value
                elif name == "--add-dir":
                    opts["add_dir"].append(value)
                i += 1
                continue
            if eq:
                die(f"unexpected value '{inline}' for '{name}' found; no more were expected")
            if name in BOOL_FLAGS or (opts["resume"] and name in RESUME_BOOL_FLAGS):
                opts["flags"].add(name)
                i += 1
                continue
            die(f"unexpected argument '{arg}' found")
        if not positionals and not opts["resume"] and arg == "resume":
            opts["resume"] = True
            i += 1
            continue
        if not positionals and not opts["resume"] and arg in SUBCOMMANDS:
            opts["sub"] = arg
            opts["sub_args"] = argv[i + 1:]
            return opts
        positionals.append(arg)
        i += 1
    if opts["resume"]:
        if len(positionals) > 2:
            die(f"unexpected argument '{positionals[2]}' found")
        opts["resume_id"] = positionals[0] if positionals else None
        opts["prompt"] = positionals[1] if len(positionals) > 1 else None
    else:
        if len(positionals) > 1:
            die(f"unexpected argument '{positionals[1]}' found")
        opts["prompt"] = positionals[0] if positionals else None
    return opts


def config_value(opts, key):
    for item in opts["config"]:
        k, _, v = item.partition("=")
        if k.strip() == key:
            try:
                return json.loads(v)
            except ValueError:
                return v
    return None


# ── hooks (config.toml, trust-gated) ────────────────────────────────────

def _snake(event):
    return re.sub(r"(?<!^)(?=[A-Z])", "_", event).lower()


def _config_key_source():
    # codex canonicalizes $CODEX_HOME (find_codex_home); ~/.codex is used as is.
    if os.environ.get("CODEX_HOME"):
        return os.path.join(os.path.realpath(CODEX_HOME), "config.toml")
    return os.path.join(CODEX_HOME, "config.toml")


def hook_hash(event, group, handler):
    """codex-rs hooks/src/engine/discovery.rs hook_hash + version_for_toml."""
    timeout = handler.get("timeout")
    if event in ("SessionEnd", "Interrupt"):
        timeout = min(max(1 if timeout is None else timeout, 1), 3)
    else:
        timeout = max(600 if timeout is None else timeout, 1)
    norm = {"type": "command", "command": handler["command"], "timeout": timeout,
            "async": bool(handler.get("async", False))}
    if isinstance(handler.get("statusMessage"), str):
        norm["statusMessage"] = handler["statusMessage"]
    ident = {"event_name": _snake(event), "hooks": [norm]}
    matcher = None if event in ("UserPromptSubmit", "Stop", "Interrupt") else group.get("matcher")
    if isinstance(matcher, str):
        ident["matcher"] = matcher
    data = json.dumps(ident, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + hashlib.sha256(data.encode()).hexdigest()


def _mini_toml_hooks(text):
    """Enough TOML for hook tables when tomllib is missing: [[hooks.E]],
    [[hooks.E.hooks]], [hooks.state."key"] and JSON-compatible scalars."""
    hooks, target = {"state": {}}, None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r'^\[\[hooks\.([A-Za-z]+)\.hooks\]\]$', line)
        if m:
            groups = hooks.setdefault(m.group(1), [])
            if not groups:
                groups.append({})
            target = {}
            groups[-1].setdefault("hooks", []).append(target)
            continue
        m = re.match(r'^\[\[hooks\.([A-Za-z]+)\]\]$', line)
        if m:
            target = {}
            hooks.setdefault(m.group(1), []).append(target)
            continue
        m = re.match(r'^\[hooks\.state\.(".*")\]$', line)
        if m:
            target = hooks["state"].setdefault(json.loads(m.group(1)), {})
            continue
        if line.startswith("["):
            target = None
            continue
        if target is not None and "=" in line:
            key, _, value = line.partition("=")
            value = value.strip()
            try:
                target[key.strip()] = json.loads(value)
            except ValueError:
                target[key.strip()] = value.strip("'")
    return {"hooks": hooks}


def load_hooks():
    """Return ({event: [group, ...]}, {key: state}, key_source). A broken
    config.toml is fatal in real codex; here it just means no hooks."""
    path = os.path.join(CODEX_HOME, "config.toml")
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
        data = tomllib.loads(raw.decode()) if tomllib else _mini_toml_hooks(raw.decode())
    except FileNotFoundError:
        return {}, {}, _config_key_source()
    except Exception as exc:
        log(f"config.toml parse error: {exc}")
        return {}, {}, _config_key_source()
    hooks = data.get("hooks", {}) or {}
    states = hooks.get("state", {}) or {}
    groups = {k: v for k, v in hooks.items() if k != "state" and isinstance(v, list)}
    return groups, states, _config_key_source()


def hook_commands(event, bypass):
    """Trust like codex 0.16x: run only when trusted_hash == the current hash."""
    groups, states, key_source = load_hooks()
    runnable, untrusted = [], 0
    for g, group in enumerate(groups.get(event, [])):
        for h, handler in enumerate(group.get("hooks", []) or []):
            if handler.get("type", "command") != "command" or not handler.get("command"):
                continue
            state = states.get(f"{key_source}:{_snake(event)}:{g}:{h}") or {}
            if state.get("enabled") is False:
                continue
            if bypass or state.get("trusted_hash") == hook_hash(event, group, handler):
                runnable.append(handler["command"])
            else:
                untrusted += 1
    return runnable, untrusted


def count_untrusted(bypass):
    groups, _, _ = load_hooks()
    return sum(hook_commands(event, bypass)[1] for event in groups)


# ── workspace trust ([projects."<path>"] trust_level) ─────────────────

def project_root(cwd):
    try:
        out = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=cwd,
                             capture_output=True, text=True, timeout=5)
        if out.returncode == 0 and out.stdout.strip():
            return os.path.realpath(out.stdout.strip())
    except Exception:
        pass
    return os.path.realpath(cwd)


def trust_level(root):
    path = os.path.join(CODEX_HOME, "config.toml")
    try:
        text = open(path, encoding="utf-8").read()
    except OSError:
        return None
    if tomllib:
        try:
            projects = tomllib.loads(text).get("projects") or {}
            entry = projects.get(root) or {}
            return entry.get("trust_level")
        except Exception:
            pass
    m = re.search(r'^\[projects\.' + re.escape(json.dumps(root)) + r'\]\s*\ntrust_level\s*=\s*"([^"]+)"',
                  text, re.M)
    return m.group(1) if m else None


def persist_trust(root):
    path = os.path.join(CODEX_HOME, "config.toml")
    os.makedirs(CODEX_HOME, exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(f'\n[projects.{json.dumps(root)}]\ntrust_level = "trusted"\n')


# ── rollout files ───────────────────────────────────────────────────────

def uuid7():
    rand = uuid.uuid4().hex
    h = f"{int(time.time() * 1000) & 0xFFFFFFFFFFFF:012x}" + "7" + rand[:3] + "8" + rand[3:18]
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def find_rollout(thread_id):
    root = os.path.join(CODEX_HOME, "sessions")
    for dirpath, _, files in os.walk(root):
        for name in files:
            if name.endswith(".jsonl") and thread_id in name:
                return os.path.join(dirpath, name)
    return None


class Rollout:
    def __init__(self, path, thread_id):
        self.path = path
        self.thread_id = thread_id
        self.ordinal = 0
        try:
            with open(path, encoding="utf-8") as fh:
                self.ordinal = sum(1 for _ in fh)
        except OSError:
            pass

    @classmethod
    def create(cls, cwd, opts, thread_source="user", parent=None, thread_id=None):
        thread_id = thread_id or uuid7()
        now = datetime.datetime.now()
        day = os.path.join(CODEX_HOME, "sessions", now.strftime("%Y"), now.strftime("%m"), now.strftime("%d"))
        os.makedirs(day, exist_ok=True)
        path = os.path.join(day, f"rollout-{now.strftime('%Y-%m-%dT%H-%M-%S')}-{thread_id}.jsonl")
        r = cls(path, thread_id)
        source = "cli" if thread_source == "user" else {"subagent": {"thread_spawn": {"parent_thread_id": parent}}}
        r.write("session_meta", {
            "id": thread_id, "session_id": parent or thread_id, "timestamp": now_iso(), "cwd": cwd,
            "runtime_workspace_roots": [cwd], "originator": "codex-tui", "cli_version": VERSION,
            "source": source, "thread_source": thread_source, "model_provider": "openai",
            "base_instructions": {"text": "fake"}, "history_mode": "paginated",
            "context_window": {"tokens": 272000},
        })
        dev = config_value(opts, "developer_instructions")
        if dev:
            r.write("response_item", {"type": "message", "role": "developer",
                                      "content": [{"type": "input_text", "text": str(dev)}]})
        r.write("response_item", {"type": "message", "role": "user", "content": [
            {"type": "input_text", "text": f"<environment_context>\n  <cwd>{cwd}</cwd>\n</environment_context>"}]})
        r.write("world_state", {"cwd": cwd})
        return r

    def write(self, rtype, payload):
        line = {"timestamp": now_iso(), "type": rtype, "payload": payload, "ordinal": self.ordinal}
        self.ordinal += 1
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(line) + "\n")

    def turn(self, text, reply, opts, tool=None):
        turn_id = uuid7()
        self.write("turn_context", {"cwd": os.getcwd(), "approval_policy": opts["approval"] or "on-request",
                                    "sandbox_policy": {"type": opts["sandbox"] or "workspace-write"},
                                    "model": opts["model"] or "gpt-6-astra", "turn_id": turn_id})
        self.write("event_msg", {"type": "task_started", "turn_id": turn_id})
        self.write("response_item", {"type": "message", "role": "user",
                                     "content": [{"type": "input_text", "text": text}]})
        self.write("event_msg", {"type": "item_completed", "thread_id": self.thread_id, "turn_id": turn_id,
                                 "started_at_ms": int(time.time() * 1000), "completed_at_ms": int(time.time() * 1000),
                                 "item": {"type": "UserMessage", "id": uuid7(), "client_id": uuid7(),
                                          "content": [{"type": "text", "text": text, "text_elements": []}]}})
        if tool:
            call_id = f"call_{uuid.uuid4().hex[:12]}"
            self.write("response_item", {"type": "custom_tool_call", "call_id": call_id, "name": "exec",
                                         "input": tool, "status": "completed"})
            self.write("response_item", {"type": "custom_tool_call_output", "call_id": call_id,
                                         "output": "README.md\npackage.json\n"})
        self.write("response_item", {"type": "message", "role": "assistant", "phase": "final_answer",
                                     "content": [{"type": "output_text", "text": reply}]})
        self.write("event_msg", {"type": "item_completed", "thread_id": self.thread_id, "turn_id": turn_id,
                                 "item": {"type": "AgentMessage", "id": uuid7(), "phase": "final_answer",
                                          "content": [{"Text": {"text": reply}}]}})
        usage = {"input_tokens": 1200, "cached_input_tokens": 0, "output_tokens": 40,
                 "reasoning_output_tokens": 0, "total_tokens": 1240}
        self.write("event_msg", {"type": "token_count", "info": {"total_token_usage": usage,
                                                                 "last_token_usage": usage}})
        self.write("token_usage_record", {"turn_id": turn_id, "usage": usage})
        self.write("event_msg", {"type": "task_complete", "turn_id": turn_id, "last_agent_message": reply})


# ── TUI ─────────────────────────────────────────────────────────────────

LINES_WRITTEN = [0]


def w(text):
    LINES_WRITTEN[0] += text.count("\n")
    os.write(sys.stdout.fileno(), text.replace("\n", "\r\n").encode())


def size():
    try:
        return os.get_terminal_size(sys.stdout.fileno())
    except OSError:
        return 80, 24


def main():
    argv = sys.argv[1:]
    log(f"start argv={argv!r} cwd={os.getcwd()} HOME={HOME} CODEX_HOME={os.environ.get('CODEX_HOME')} "
        f"COMMANDER_API_URL={os.environ.get('COMMANDER_API_URL')}")
    opts = parse_args(argv)
    if "--version" in opts["flags"]:
        print(f"codex-cli {VERSION}")
        return 0
    if "--help" in opts["flags"]:
        print("Codex CLI (fake, e2e sandbox)\n\nUsage: codex [OPTIONS] [PROMPT]")
        return 0
    if opts["sub"]:
        sub, rest = opts["sub"], opts.get("sub_args", [])
        log(f"subcommand {sub} {rest!r}")
        if sub == "login":
            print("Logged in using ChatGPT" if rest[:1] == ["status"] else "Login is not available in the e2e sandbox")
            return 0 if rest[:1] == ["status"] else 1
        if sub in ("exec", "e"):
            print(f"FAKE-ONESHOT: {' '.join(a for a in rest if not a.startswith('-'))[:200]}")
            return 0
        return 0
    if not sys.stdin.isatty():
        die("stdin is not a terminal", 1)

    bypass_trust = "--dangerously-bypass-hook-trust" in opts["flags"]
    cwd = os.getcwd()
    rollout = None
    if opts["resume"]:
        if not opts["resume_id"]:
            die("no session id given and --last not set", 1)
        path = find_rollout(opts["resume_id"])
        if not path:
            sys.stderr.write(f"Error: No saved session found with ID {opts['resume_id']}. "
                             "Run `codex resume` without an ID to choose from existing sessions.\n")
            log(f"resume miss {opts['resume_id']}")
            return 1
        rollout = Rollout(path, opts["resume_id"])
        log(f"resume {opts['resume_id']}")

    new_id = [None]  # id of a /new thread whose rollout does not exist yet

    def thread_id():
        return rollout.thread_id if rollout else new_id[0]

    def fire(event, **extra):
        cmds, untrusted = hook_commands(event, bypass_trust)
        payload = {"hook_event_name": event, "session_id": thread_id(), "cwd": cwd,
                   "transcript_path": rollout.path if rollout else None, **extra}
        log(f"hook {event} -> {len(cmds)} command(s), {untrusted} untrusted")
        for cmd in cmds:
            try:
                proc = subprocess.run(["/bin/sh", "-c", cmd], input=json.dumps(payload),
                                      capture_output=True, text=True, timeout=15)
                if proc.returncode or proc.stderr.strip():
                    log(f"hook {event} rc={proc.returncode} err={proc.stderr.strip()[:300]}")
            except Exception as exc:
                log(f"hook {event} failed: {exc}")

    def do_turn(text):
        nonlocal rollout
        if rollout is None:
            rollout = Rollout.create(cwd, opts, thread_id=new_id[0])
            new_id[0] = None
            log(f"rollout {rollout.path} id={rollout.thread_id}")
        fire("UserPromptSubmit", prompt=text, turn_id=uuid7())
        w("• Working (0s • esc to interrupt)\n")
        # "slow <x>" works long enough to queue follow-ups in tests.
        time.sleep(6.0 if text.startswith("slow") else 1.5)
        reply = f"FAKE-CODEX-REPLY: {text}"
        rollout.turn(text, reply, opts, tool="ls")
        if text.startswith("spawn"):
            child = Rollout.create(cwd, opts, thread_source="subagent", parent=rollout.thread_id)
            child.turn(f"subagent task: {text[5:].strip()}", "FAKE-SUBAGENT-REPLY", opts)
            log(f"subagent rollout {child.path} id={child.thread_id} parent={rollout.thread_id}")
        w(f"• {reply}\n")
        fire("Stop", stop_hook_active=False, last_assistant_message=reply)

    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    tty.setraw(fd)
    resized = []
    signal.signal(signal.SIGWINCH, lambda *_: resized.append(1))
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit(0)))
    cols, rows = size()
    w("\x1b[2J\x1b[H")
    w(f">_ OpenAI Codex (v{VERSION})  FAKE CODEX (e2e sandbox) {cols}x{rows}\n")
    w(f"model: {opts['model'] or 'gpt-6-astra'}   directory: {cwd}\n")
    untrusted = count_untrusted(bypass_trust)
    if untrusted:
        w(f"⚠ {untrusted} hooks need review before they can run. Open /hooks to review them.\n")
    log("size %dx%d" % (cols, rows))
    root = project_root(cwd)
    trust_pending = trust_level(root) not in ("trusted", "untrusted")

    def after_trust():
        fire("SessionStart", source="resume" if opts["resume"] else "startup")
        if opts["prompt"]:
            do_turn(opts["prompt"])
        w("› ")

    if trust_pending:
        log(f"trust menu shown for {root}")
        w("Trust this folder? Codex can read, edit, and run files here, subject to your\n"
          "permission settings. Folder settings can run code automatically, even without a\n"
          "model request. Continue only if you trust these files. Your trust decision will be saved.\n\n"
          "› 1. Trust and continue\n  2. Open restricted\n")
    else:
        after_trust()
    line, pending = "", None
    try:
        while True:
            if resized:
                resized.clear()
                cols, rows = size()
                log(f"resize {cols}x{rows}")
                w(f"\n[resize {cols}x{rows}]\n› {line}")
            try:
                ready, _, _ = select.select([fd], [], [], 0.2)
            except InterruptedError:
                continue
            if not ready:
                continue
            data = os.read(fd, 1024)
            if not data:
                break
            for ch in data.decode("utf-8", "replace"):
                if trust_pending:
                    if ch in ("\r", "\n", "1"):
                        trust_pending = False
                        persist_trust(root)
                        log(f"trust accepted {root}")
                        w("\n")
                        after_trust()
                    elif ch.isprintable():
                        log(f"trust menu dropped {ch!r}")
                    continue
                if ch in ("\r", "\n"):
                    w("\n")
                    text, line = line.strip(), ""
                    log(f"input {text!r}")
                    if pending:
                        tool, pending = pending, None
                        if text.startswith("1") or text.lower().startswith("y"):
                            fire("PostToolUse", tool_name="Bash", tool_input={"command": tool},
                                 tool_use_id="call_fake", tool_response="ok")
                            w(f"✔ Ran {tool}\n")
                        else:
                            w("✗ Denied\n")
                        fire("Stop", stop_hook_active=False)
                    elif text == "quit":
                        return 0
                    elif text in ("/new", "/clear"):
                        # New thread under the same PTY; its rollout is lazy again.
                        rollout = None
                        new_id[0] = uuid7()
                        log(f"new thread {new_id[0]}")
                        w("• Started a new conversation\n")
                        fire("SessionStart", source="clear")
                    elif text.startswith("ask"):
                        tool = text[3:].strip() or "rm -rf build"
                        fire("UserPromptSubmit", prompt=text)
                        fire("PreToolUse", tool_name="Bash", tool_input={"command": tool}, tool_use_id="call_fake")
                        fire("PermissionRequest", tool_name="Bash", tool_input={"command": tool},
                             tool_use_id="call_fake")
                        w(f"Would you like to run the following command?\n  $ {tool}\n"
                          "› 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)\n")
                        pending = tool
                    elif text:
                        do_turn(text)
                    w("› ")
                elif ch in ("\x7f", "\b"):
                    if line:
                        line = line[:-1]
                        w("\b \b")
                elif ch == "\x03":
                    return 130
                elif ch == "\x1b":
                    pass
                elif ch.isprintable():
                    line += ch
                    w(ch)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)
        log("exit")
    return 0


if __name__ == "__main__":
    sys.exit(main())
