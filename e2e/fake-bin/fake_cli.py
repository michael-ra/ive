#!/usr/bin/env python3
"""Stand-in for the `claude` / `gemini` CLIs inside the IVE end-to-end sandbox.

Installed as <sandbox>/bin/claude and <sandbox>/bin/gemini by e2e/run.mjs.
It never talks to the network and needs no API key. It behaves just enough
like a TUI for IVE: prompt, echo, resize repaint, and lifecycle hook events
sent through the relay script IVE installed into the (fake) CLI settings.

Commands typed into the prompt:
  ask <text>   -> PermissionRequest + Notification hooks, approval dialog;
                  then "1" approves (PostToolUse + Stop), "2" denies
  quit         -> exit 0
  lines <n>    -> print n numbered lines (scrollback)
  slow <text>  -> like anything, but thinks 8 s (time to interrupt)
  anything     -> UserPromptSubmit hook, "thinking", reply, Stop hook

Keys (each logged as "key <name>" in fake-cli.log): Esc interrupts a turn,
Ctrl-C clears the typed line / interrupts / exits when pressed twice on an
empty line, Up/Down recall earlier inputs, Tab, Ctrl-D, Ctrl-R, Shift-Tab.
"""
import json
import os
import select
import signal
import subprocess
import sys
import termios
import time
import tty

NAME = os.path.basename(sys.argv[0])
IS_GEMINI = NAME.startswith("gemini")
EVENTS = {
    "start": "SessionStart",
    "prompt": "BeforeAgent" if IS_GEMINI else "UserPromptSubmit",
    "stop": "AfterAgent" if IS_GEMINI else "Stop",
    "pre_tool": "BeforeTool" if IS_GEMINI else "PreToolUse",
    "post_tool": "AfterTool" if IS_GEMINI else "PostToolUse",
    "permission": "Notification" if IS_GEMINI else "PermissionRequest",
    "notification": "Notification",
}
HOME = os.environ.get("HOME", "")
LOG = os.path.join(HOME, "fake-cli.log")
SESSION = os.environ.get("COMMANDER_SESSION_ID") or f"fake-{os.getpid()}"
# Like Claude Code: `--resume <id>` continues that conversation, and its
# SessionStart hook reports source=resume with the same id. IVE replaces the
# stored native id on startup/clear/compact, so a resumed fake must not claim
# a fresh startup.
RESUME_ID = None
if "--resume" in sys.argv[1:]:
    _i = sys.argv.index("--resume")
    if _i + 1 < len(sys.argv) and not sys.argv[_i + 1].startswith("-"):
        RESUME_ID = sys.argv[_i + 1]
        SESSION = RESUME_ID



def _flag(name):
    argv = sys.argv[1:]
    if name in argv:
        i = argv.index(name)
        if i + 1 < len(argv) and not argv[i + 1].startswith("-"):
            return argv[i + 1]
    return None


# Like Claude Code: --model / --effort pick what every turn runs on, and each
# assistant record in the transcript carries message.model and effort.
MODEL = _flag("--model") or "fake-default-model"
EFFORT = _flag("--effort")


def transcript_paths():
    if IS_GEMINI or not RESUME_ID:
        return []
    import glob
    for base in (os.environ.get("CLAUDE_CONFIG_DIR"), os.path.join(HOME, ".claude")):
        if base:
            hits = glob.glob(os.path.join(base, "projects", "*", f"{RESUME_ID}.jsonl"))
            if hits:
                return hits
    return []


def record_turn(text):
    """Append user + assistant records to an existing resumed transcript."""
    paths = transcript_paths()
    if not paths:
        return
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + f".{int(time.time() * 1000) % 1000:03d}Z"
    recs = [
        {"type": "user", "sessionId": RESUME_ID, "timestamp": stamp, "message": {"role": "user", "content": text}},
        {"type": "assistant", "sessionId": RESUME_ID, "timestamp": stamp, "effort": EFFORT,
         "message": {"role": "assistant", "model": MODEL, "content": [{"type": "text", "text": f"FAKE-REPLY: {text}"}]}},
    ]
    for path in paths:  # Claude-style cwd encoding can leave two copies
        try:
            with open(path, "a", encoding="utf-8") as fh:
                for rec in recs:
                    fh.write(json.dumps(rec) + "\n")
        except OSError:
            pass


def log(msg):
    try:
        with open(LOG, "a", encoding="utf-8") as fh:
            stamp = time.strftime('%H:%M:%S') + f".{int(time.time() * 1000) % 1000:03d}"
            fh.write(f"{stamp} {NAME}[{os.getpid()}] {msg}\n")
    except OSError:
        pass


def settings_path():
    if IS_GEMINI:
        return os.path.join(HOME, ".gemini", "settings.json")
    cfg = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(HOME, ".claude")
    return os.path.join(cfg, "settings.json")


def hook_commands(event):
    paths = [settings_path()]
    # `--settings <file>` (claude) may carry additional hooks.
    argv = sys.argv[1:]
    if "--settings" in argv:
        i = argv.index("--settings")
        if i + 1 < len(argv) and argv[i + 1].strip().startswith("/"):
            paths.append(argv[i + 1])
    out = []
    for path in paths:
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            continue
        for group in (data.get("hooks") or {}).get(event, []) or []:
            for hook in group.get("hooks", []) or []:
                if hook.get("type", "command") == "command" and hook.get("command"):
                    out.append(hook["command"])
    return out


def fire(kind, **extra):
    event = EVENTS[kind]
    payload = {"hook_event_name": event, "session_id": SESSION, "cwd": os.getcwd(),
               "transcript_path": "", **extra}
    cmds = hook_commands(event)
    log(f"hook {event} -> {len(cmds)} command(s)")
    for cmd in cmds:
        try:
            proc = subprocess.run(["/bin/sh", "-c", cmd], input=json.dumps(payload),
                                  capture_output=True, text=True, timeout=15)
            if proc.returncode or proc.stderr.strip():
                log(f"hook {event} rc={proc.returncode} err={proc.stderr.strip()[:300]}")
        except Exception as exc:  # never crash the TUI because a hook failed
            log(f"hook {event} failed: {exc}")


def size():
    try:
        cols, rows = os.get_terminal_size(sys.stdout.fileno())
        return cols, rows
    except OSError:
        return 80, 24


LINES_WRITTEN = [0]


def w(text):
    LINES_WRITTEN[0] += text.count("\n")
    os.write(sys.stdout.fileno(), text.replace("\n", "\r\n").encode())


def banner():
    cols, rows = size()
    title = f" FAKE {NAME.upper()} (e2e sandbox) {cols}x{rows} "
    w("\x1b[2J\x1b[H")
    w("+" + title.center(max(0, cols - 2), "-")[: max(0, cols - 2)] + "+\n")
    w(f"model {MODEL}" + (f" · effort {EFFORT}" if EFFORT else "") + "\n")
    w("Type a message. 'ask <x>' requests a permission.\n")


def prompt():
    w("\x1b[1m> \x1b[0m")


def main():
    log(f"start argv={sys.argv[1:]!r} cwd={os.getcwd()} HOME={HOME} "
        f"CLAUDE_CONFIG_DIR={os.environ.get('CLAUDE_CONFIG_DIR')} "
        f"COMMANDER_API_URL={os.environ.get('COMMANDER_API_URL')}")
    if "--version" in sys.argv[1:]:
        print("0.0.0-fake (e2e)")
        return 0
    if not sys.stdin.isatty():
        # One-shot (`-p`) usage: answer and leave.
        data = sys.stdin.read() if not sys.argv[1:] else " ".join(sys.argv[1:])
        print(f"FAKE-ONESHOT: {data[:200]}")
        return 0

    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    tty.setraw(fd)
    resized = []
    signal.signal(signal.SIGWINCH, lambda *_: resized.append(1))
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit(0)))
    banner()
    log("size %dx%d" % size())
    fire("start", source="resume" if RESUME_ID else "startup")
    prompt()
    st = {"line": "", "pending": None, "dialog_at": 0, "tool_use_id": "",
          "busy": None, "history": [], "hist_i": None, "last_ctrl_c": 0.0}
    esc = {"buf": None}  # escape sequence being read (spans chunks)

    def redraw_line():
        w("\r\x1b[2K")
        prompt()
        w(st["line"])

    def finish_turn(text):
        w(f"FAKE-REPLY: {text}\n")
        record_turn(text)
        fire("stop", stop_hook_active=False)
        prompt()
        w(st["line"])

    def interrupt(how):
        # Like Claude Code: Esc (or Ctrl-C) while it works stops the turn.
        text = st["busy"][1]
        st["busy"] = None
        log(f"interrupted by {how} ({text!r})")
        w(f"\n[interrupted by {how}]\n")
        fire("stop", stop_hook_active=False)
        prompt()
        w(st["line"])

    def key(name):
        log(f"key {name}")
        if name == "esc":
            if st["busy"]:
                interrupt("esc")
            return
        if name in ("up", "down"):
            hist = st["history"]
            if not hist:
                return
            i = st["hist_i"]
            if name == "up":
                i = len(hist) - 1 if i is None else max(0, i - 1)
            else:
                i = None if i is None or i >= len(hist) - 1 else i + 1
            st["hist_i"] = i
            st["line"] = hist[i] if i is not None else ""
            redraw_line()
            return
        if name == "ctrl-r":
            w("\r\x1b[2K(reverse-i-search)`': ")
            w(st["line"])
            return

    def submit():
        w("\n")
        text, st["line"] = st["line"].strip(), ""
        st["hist_i"] = None
        log(f"input {text!r}")
        if text and (not st["history"] or st["history"][-1] != text):
            st["history"].append(text)
        if st["pending"]:
            tool = st["pending"]
            st["pending"] = None
            # Like Claude Code: the approval dialog is replaced, not left on screen.
            up = LINES_WRITTEN[0] - st["dialog_at"]
            if up > 0:
                w(f"\x1b[{up}A\r\x1b[J")
            if text.startswith("1") or text.lower().startswith("y"):
                fire("post_tool", tool_name="Bash", tool_input={"command": tool}, tool_use_id=st["tool_use_id"],
                     tool_response={"stdout": "ok"})
                w(f"Approved. Ran: {tool}\n")
            else:
                w("Denied.\n")
            fire("stop", stop_hook_active=False)
        elif text == "quit":
            raise SystemExit(0)
        elif text.startswith("lines"):
            # Scrollback for tests: "lines 120" prints 120 numbered lines.
            try:
                n = max(1, min(2000, int(text.split()[1])))
            except (IndexError, ValueError):
                n = 100
            for i in range(1, n + 1):
                w(f"line {i:04d} of {n}\n")
        elif text.startswith("ask"):
            tool = text[3:].strip() or "rm -rf build"
            fire("prompt", prompt=text)
            st["tool_use_id"] = f"toolu_fake_{int(time.time() * 1000)}"
            fire("pre_tool", tool_name="Bash", tool_input={"command": tool}, tool_use_id=st["tool_use_id"])
            fire("permission", tool_name="Bash", tool_input={"command": tool}, tool_use_id=st["tool_use_id"],
                 message=f"Claude needs your permission to use Bash")
            if not IS_GEMINI:
                fire("notification", message="Claude needs your permission to use Bash",
                     notification_type="permission_prompt")
            st["dialog_at"] = LINES_WRITTEN[0]
            w(f"Bash command\n  {tool}\nDo you want to proceed?\n 1. Yes\n 2. No\nEsc to cancel\n")
            st["pending"] = tool
        elif text:
            fire("prompt", prompt=text)
            w("* Thinking...\n")
            # "slow <x>" thinks long enough to be interrupted in tests.
            st["busy"] = (time.time() + (8.0 if text.startswith("slow") else 1.2), text)
            return
        prompt()

    def feed(ch):
        # Escape sequences: ESC [ ... final, ESC O x. A lone ESC is the Esc key.
        if esc["buf"] is not None:
            esc["buf"] += ch
            b = esc["buf"]
            if len(b) == 1 and ch not in "[O":
                esc["buf"] = None
                key("esc")
                feed(ch)
                return
            if len(b) >= 2 and (b[0] == "O" or "@" <= ch <= "~"):
                esc["buf"] = None
                final = b[-1]
                mods = ";5" in b
                name = {"A": "up", "B": "down", "C": "right", "D": "left", "Z": "shift-tab",
                        "H": "home", "F": "end"}.get(final, f"esc-seq {b!r}")
                key(("ctrl-" if mods else "") + name if name in ("up", "down", "left", "right") else name)
            return
        if ch == "\x1b":
            esc["buf"] = ""
            return
        if ch in ("\r", "\n"):
            submit()
        elif ch in ("\x7f", "\b"):
            if st["line"]:
                st["line"] = st["line"][:-1]
                w("\b \b")
        elif ch == "\x03":
            log("key ctrl-c")
            if st["busy"]:
                interrupt("ctrl-c")
            elif st["line"]:
                # Like Claude Code: Ctrl-C first clears what is typed.
                st["line"] = ""
                w("^C")
                redraw_line()
            elif time.time() - st["last_ctrl_c"] < 2.0:
                raise SystemExit(130)
            else:
                w("\r\x1b[2KPress Ctrl-C again to exit\n")
                prompt()
            st["last_ctrl_c"] = time.time()
        elif ch == "\t":
            key("tab")
        elif ch == "\x04":
            key("ctrl-d")
        elif ch == "\x12":
            key("ctrl-r")
        elif ord(ch) < 32:
            key(f"ctrl-{chr(ord(ch) + 96)}")
        elif ch.isprintable():
            st["line"] += ch
            w(ch)

    try:
        while True:
            if resized:
                resized.clear()
                cols, rows = size()
                log(f"resize {cols}x{rows}")
                w(f"\n[resize {cols}x{rows}]\n")
                prompt()
                w(st["line"])
            if st["busy"] and time.time() >= st["busy"][0]:
                text = st["busy"][1]
                st["busy"] = None
                finish_turn(text)
            try:
                ready, _, _ = select.select([fd], [], [], 0.1)
            except InterruptedError:
                continue
            if not ready:
                if esc["buf"] == "":
                    esc["buf"] = None
                    key("esc")
                continue
            data = os.read(fd, 1024)
            if not data:
                break
            for ch in data.decode("utf-8", "replace"):
                feed(ch)
            if esc["buf"] == "":
                # A lone ESC at the end of a chunk is the Esc key.
                esc["buf"] = None
                key("esc")
    except SystemExit as exc:
        return exc.code if isinstance(exc.code, int) else 0
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)
        log("exit")
    return 0


if __name__ == "__main__":
    sys.exit(main())
