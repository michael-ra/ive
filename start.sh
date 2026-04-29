#!/bin/bash
set -e

SOURCE="$0"
while [ -L "$SOURCE" ]; do
  DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
DB_PATH="$HOME/.ive/data.db"
IVE_HOME="$HOME/.ive"
VENV_DIR="$IVE_HOME/venv"

# ── Parse flags ──────────────────────────────────────────────
MULTIPLAYER=false
TUNNEL=false
PASSTHROUGH_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --help|-h)
      echo "Usage: ./start.sh [options]"
      echo ""
      echo "Options:"
      echo "  --multiplayer   Build frontend & serve from backend on 0.0.0.0 with auth token"
      echo "  --tunnel        Start a Cloudflare tunnel for internet access (implies --multiplayer)"
      echo "  --headless      Don't open browser on startup"
      echo "  --token TOKEN   Set auth token (auto-generated if omitted with --multiplayer/--tunnel)"
      echo "  --port PORT     Backend port (default: 5111)"
      echo "  --host HOST     Bind address (default: 127.0.0.1, or 0.0.0.0 with --multiplayer)"
      echo "  --recheck-deps  Force re-running the dependency check (ignores cache stamp)"
      echo ""
      echo "Examples:"
      echo "  ./start.sh                        # Dev mode (backend + Vite frontend)"
      echo "  ./start.sh --multiplayer           # Production mode with auth"
      echo "  ./start.sh --tunnel                # Production mode + Cloudflare tunnel"
      exit 0
      ;;
    --multiplayer) MULTIPLAYER=true; PASSTHROUGH_ARGS+=("$arg") ;;
    --tunnel) TUNNEL=true; MULTIPLAYER=true; PASSTHROUGH_ARGS+=("$arg") ;;
    --headless) PASSTHROUGH_ARGS+=("$arg") ;;
    --token|--token=*) PASSTHROUGH_ARGS+=("$arg") ;;
    --port|--port=*) PASSTHROUGH_ARGS+=("$arg") ;;
    --host|--host=*) PASSTHROUGH_ARGS+=("$arg") ;;
    --recheck-deps) RECHECK_DEPS=true ;;
    *) PASSTHROUGH_ARGS+=("$arg") ;;
  esac
done

mkdir -p "$IVE_HOME"

# ── Dependency detection + venv bootstrap ────────────────────
# Cross-platform helpers: macOS bash 3.2 compatible, no `which`.

ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; }
err()  { printf "  \033[31m✗\033[0m %s\n" "$1"; }

# Portable md5 of stdin → stdout.
hash_stdin() {
  if command -v md5 >/dev/null 2>&1; then
    md5 -q
  elif command -v md5sum >/dev/null 2>&1; then
    md5sum | cut -d' ' -f1
  else
    # Last-resort: cksum gives a usable, stable digest.
    cksum | cut -d' ' -f1
  fi
}

# What python3 binary should the rest of the script use?
# After check_deps runs successfully this points to either system python3
# or to ~/.ive/venv/bin/python3.
PYTHON_BIN="python3"
PIP_BIN="pip3"

deps_cache_hash() {
  {
    [ -f "$DIR/backend/requirements.txt" ] && cat "$DIR/backend/requirements.txt"
    [ -f "$DIR/frontend/package.json" ]    && cat "$DIR/frontend/package.json"
    [ -f "$DIR/start.sh" ]                 && cat "$DIR/start.sh"
  } 2>/dev/null | hash_stdin
}

check_deps() {
  local cache_hash stamp
  cache_hash=$(deps_cache_hash)
  stamp="$IVE_HOME/.deps-checked.$cache_hash"

  # Fast path: cache hit and the venv (if recorded) still exists.
  if [ -z "$RECHECK_DEPS" ] && [ -f "$stamp" ]; then
    # Source recorded PYTHON_BIN/PIP_BIN if any.
    # shellcheck disable=SC1090
    . "$stamp" 2>/dev/null || true
    if [ -n "$PYTHON_BIN" ] && command -v "$PYTHON_BIN" >/dev/null 2>&1; then
      return 0
    fi
    # Stamp pointed at a missing interpreter (e.g. venv was deleted).
    rm -f "$stamp"
  fi

  echo "Checking dependencies..."

  # ── git (required) ──────────────────────────────────────────
  if command -v git >/dev/null 2>&1; then
    ok "git ($(git --version 2>/dev/null | awk '{print $3}'))"
  else
    err "git — required. Install: https://git-scm.com/downloads"
    exit 1
  fi

  # ── python3 (required, 3.11+) ───────────────────────────────
  if ! command -v python3 >/dev/null 2>&1; then
    err "python3 — required."
    case "$(uname -s)" in
      Darwin) echo "      Install: brew install python@3.12" ;;
      Linux)  echo "      Install: sudo apt-get install python3.12 python3.12-venv  (Debian/Ubuntu)" ;;
      *)      echo "      See: https://www.python.org/downloads/" ;;
    esac
    exit 1
  fi
  local py_ver py_major py_minor
  py_ver=$(python3 -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])' 2>/dev/null || echo "unknown")
  py_major=$(python3 -c 'import sys; print(sys.version_info[0])' 2>/dev/null || echo 0)
  py_minor=$(python3 -c 'import sys; print(sys.version_info[1])' 2>/dev/null || echo 0)
  if [ "$py_major" -lt 3 ] || { [ "$py_major" -eq 3 ] && [ "$py_minor" -lt 11 ]; }; then
    err "python3 ($py_ver) — need 3.11 or newer."
    case "$(uname -s)" in
      Darwin) echo "      Upgrade: brew install python@3.12" ;;
      Linux)  echo "      Upgrade: sudo apt-get install python3.12 python3.12-venv" ;;
    esac
    exit 1
  fi
  ok "python3 ($py_ver)"

  # ── node + npm (required) ───────────────────────────────────
  if ! command -v node >/dev/null 2>&1; then
    err "node — required. Install: https://nodejs.org/ (or: nvm install 20)"
    exit 1
  fi
  if ! command -v npm >/dev/null 2>&1; then
    err "npm — required (usually shipped with node)."
    exit 1
  fi
  ok "node ($(node --version 2>/dev/null))"
  ok "npm ($(npm --version 2>/dev/null))"

  # ── pip / venv decision ─────────────────────────────────────
  # PEP 668 ("externally-managed-environment") makes system-pip refuse
  # writes on Homebrew Python and Debian/Ubuntu. Probe by attempting a
  # harmless pip operation; if it fails for that reason, switch to a
  # private venv at ~/.ive/venv.
  local need_venv=false
  local probe_out
  if ! python3 -m pip --version >/dev/null 2>&1; then
    # No pip module at all — try ensurepip, else fall back to venv (which
    # ships its own pip).
    if python3 -m ensurepip --version >/dev/null 2>&1; then
      python3 -m ensurepip --upgrade >/dev/null 2>&1 || true
    fi
    if ! python3 -m pip --version >/dev/null 2>&1; then
      need_venv=true
    fi
  fi
  if [ "$need_venv" = false ]; then
    # Probe install of a tiny package in dry-run mode. The flag was added
    # in pip 23, which is also when PEP 668 enforcement landed — so if
    # --dry-run is unsupported we're on an old enough pip that PEP 668
    # isn't an issue. We only inspect stderr; we never actually install.
    probe_out=$(python3 -m pip install --dry-run --quiet --disable-pip-version-check pip 2>&1 || true)
    case "$probe_out" in
      *externally-managed-environment*|*"externally managed"*)
        need_venv=true ;;
    esac
  fi

  if [ "$need_venv" = true ] || [ -d "$VENV_DIR" ]; then
    if [ ! -x "$VENV_DIR/bin/python3" ]; then
      echo "  Creating Python venv at $VENV_DIR (system pip is externally-managed)..."
      if ! python3 -m venv "$VENV_DIR" 2>/dev/null; then
        err "python3 -m venv failed."
        case "$(uname -s)" in
          Linux) echo "      Try: sudo apt-get install python3-venv" ;;
        esac
        exit 1
      fi
    fi
    PYTHON_BIN="$VENV_DIR/bin/python3"
    PIP_BIN="$VENV_DIR/bin/pip3"
    ok "venv ($VENV_DIR)"
  else
    PYTHON_BIN="python3"
    if command -v pip3 >/dev/null 2>&1; then
      PIP_BIN="pip3"
    else
      PIP_BIN="python3 -m pip"
    fi
    ok "pip ($($PYTHON_BIN -m pip --version 2>/dev/null | awk '{print $2}'))"
  fi

  # ── sqlite3 CLI (used for auto-update setting; degrade gracefully) ──
  if command -v sqlite3 >/dev/null 2>&1; then
    ok "sqlite3 ($(sqlite3 --version 2>/dev/null | awk '{print $1}'))"
  else
    warn "sqlite3 — optional. Auto-update CLI setting will be skipped. Install: brew install sqlite (macOS) / apt install sqlite3 (Linux)"
  fi

  # ── ffmpeg (optional, for Documentor GIF recording) ────────
  if command -v ffmpeg >/dev/null 2>&1; then
    ok "ffmpeg ($(ffmpeg -version 2>/dev/null | head -n1 | awk '{print $3}'))"
  else
    warn "ffmpeg — optional, GIF recording disabled. Install: brew install ffmpeg (macOS) / sudo apt-get install ffmpeg (Linux)"
  fi

  # ── claude / gemini CLIs (warn-only) ───────────────────────
  local has_cli=false
  if command -v claude >/dev/null 2>&1; then
    ok "claude CLI"
    has_cli=true
  fi
  if command -v gemini >/dev/null 2>&1; then
    ok "gemini CLI"
    has_cli=true
  fi
  if [ "$has_cli" = false ]; then
    warn "no CLI detected. Install at least one to actually run sessions:"
    echo "      Claude Code: https://docs.anthropic.com/claude-code"
    echo "      Gemini CLI:  https://github.com/google-gemini/gemini-cli"
  fi

  # Persist the resolved interpreter selection.
  {
    echo "PYTHON_BIN=\"$PYTHON_BIN\""
    echo "PIP_BIN=\"$PIP_BIN\""
  } > "$stamp"
}

# Install backend dependencies into the resolved interpreter (system or venv).
install_backend_deps() {
  local req="$DIR/backend/requirements.txt"
  # Stamp inside the venv (or backend/) so nuking ~/.ive resets pip state too.
  local stamp
  if [ "$PYTHON_BIN" = "$VENV_DIR/bin/python3" ]; then
    stamp="$VENV_DIR/.deps-installed"
  else
    stamp="$DIR/backend/.deps-installed"
  fi

  if [ ! -f "$stamp" ] || [ "$req" -nt "$stamp" ]; then
    echo "Installing backend dependencies..."
    "$PYTHON_BIN" -m pip install --quiet --upgrade pip 2>&1 | sed 's/^/  /' || true
    if ! "$PYTHON_BIN" -m pip install --quiet -r "$req" 2>&1 | sed 's/^/  /'; then
      err "pip install failed. See output above."
      exit 1
    fi
    touch "$stamp"
  else
    echo "Backend deps up to date."
  fi
}

# Install Playwright Chromium browser once. Chromium is ~150MB; only the
# screenshot/preview/GIF features need it, but installing up front makes
# the first-use experience much smoother.
install_playwright_browser() {
  local stamp="$IVE_HOME/.playwright-installed"
  if [ -f "$stamp" ]; then
    return 0
  fi
  if ! "$PYTHON_BIN" -c 'import playwright' >/dev/null 2>&1; then
    # Playwright wheel not installed (user commented it out of requirements).
    return 0
  fi
  echo "Installing Playwright Chromium (one-time, ~150MB)..."
  if ( set -o pipefail; "$PYTHON_BIN" -m playwright install chromium 2>&1 | sed 's/^/  /' ); then
    touch "$stamp"
  else
    warn "Playwright Chromium install failed. Screenshots/preview/GIF features will prompt to install on demand."
  fi
}

# Pre-fetch fastembed model weights (BAAI/bge-small-en-v1.5 + cross-encoder
# reranker) so the first semantic-search/coordination call doesn't have to
# download ~56MB of ONNX weights on demand. Names are pulled from
# backend/embedder.py to keep a single source of truth.
prewarm_embedding_models() {
  local stamp="$IVE_HOME/.embeddings-installed"
  if [ -f "$stamp" ]; then
    return 0
  fi
  if ! "$PYTHON_BIN" -c 'import fastembed' >/dev/null 2>&1; then
    # fastembed wheel not installed (user commented it out of requirements).
    return 0
  fi
  echo "Pre-fetching embedding model weights (one-time, ~56MB)..."
  if (
    set -o pipefail
    IVE_BACKEND_DIR="$DIR/backend" "$PYTHON_BIN" -c '
import os, sys
sys.path.insert(0, os.environ["IVE_BACKEND_DIR"])
from embedder import EMBEDDING_MODEL, RERANK_MODEL
from fastembed import TextEmbedding
print(f"Downloading {EMBEDDING_MODEL} (~33MB) ...", flush=True)
TextEmbedding(model_name=EMBEDDING_MODEL)
try:
    from fastembed.rerank.cross_encoder import TextCrossEncoder
    print(f"Downloading {RERANK_MODEL} (~23MB) ...", flush=True)
    TextCrossEncoder(model_name=RERANK_MODEL)
except ImportError:
    print("Reranker module not present in installed fastembed; skipping.")
print("Embedding models ready.")
' 2>&1 | sed 's/^/  /'
  ); then
    touch "$stamp"
  else
    warn "Embedding model pre-fetch failed. Models will download lazily on first use; semantic search falls back to keyword until then."
  fi
}

check_deps

# ── Auto-install cloudflared if --tunnel requested ──────────
if [ "$TUNNEL" = true ] && ! command -v cloudflared &>/dev/null; then
  echo "cloudflared not found — installing..."
  if command -v brew &>/dev/null; then
    brew install cloudflare/cloudflare/cloudflared 2>&1 | sed 's/^/  /'
  elif command -v apt-get &>/dev/null; then
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
    sudo apt-get update && sudo apt-get install -y cloudflared 2>&1 | sed 's/^/  /'
  else
    echo "  ERROR: Could not auto-install cloudflared."
    echo "  Install manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
    exit 1
  fi
  if ! command -v cloudflared &>/dev/null; then
    echo "  ERROR: cloudflared installation failed."
    exit 1
  fi
  echo "  cloudflared installed."
  echo ""
fi

echo "IVE — Integrated Vibecoding Environment"
echo "========================================"
echo ""

# ── Auto-update CLIs (if enabled in settings) ──────────────────
auto_update_cli() {
  # Check the app_settings table for auto_update_cli = 'on'
  if [ -f "$DB_PATH" ] && command -v sqlite3 &>/dev/null; then
    local val
    val=$(sqlite3 "$DB_PATH" "SELECT value FROM app_settings WHERE key = 'auto_update_cli';" 2>/dev/null || true)
    if [ "$val" = "on" ]; then
      echo "Auto-updating CLIs..."

      # Update Claude Code
      if command -v claude &>/dev/null; then
        echo "  Updating Claude Code..."
        claude update 2>&1 | sed 's/^/    /' || echo "    (update skipped)"
      fi

      # Update Gemini CLI
      if command -v gemini &>/dev/null; then
        if command -v brew &>/dev/null && brew list gemini-cli &>/dev/null 2>&1; then
          echo "  Updating Gemini CLI (brew)..."
          brew upgrade gemini-cli 2>&1 | sed 's/^/    /' || echo "    (already up to date)"
        elif command -v npm &>/dev/null; then
          echo "  Updating Gemini CLI (npm)..."
          npm update -g @google/gemini-cli 2>&1 | sed 's/^/    /' || echo "    (update skipped)"
        fi
      fi

      echo ""
    fi
  fi
}

auto_update_cli

install_backend_deps
install_playwright_browser
prewarm_embedding_models

# Install frontend deps
if [ ! -d "$DIR/frontend/node_modules" ]; then
  echo "Installing frontend dependencies..."
  (cd "$DIR/frontend" && npm install)
fi


# ── Kill stale processes on our ports ─────────────────────────
kill_port() {
  local port=$1
  local pids
  pids=$(lsof -ti :"$port" 2>/dev/null) || true
  if [ -n "$pids" ]; then
    echo "  Killing stale process(es) on port $port..."
    echo "$pids" | xargs kill -9 2>/dev/null || true
    sleep 0.5
  fi
}

kill_port 5111

# ── Multiplayer mode: build frontend, single-process ─────────
if [ "$MULTIPLAYER" = true ]; then
  echo ""
  echo "Multiplayer mode — building frontend and starting server..."
  echo ""

  # Build frontend for static serving from backend.
  # Rebuild if dist/ is missing or any source file changed since last build.
  DIST_STAMP="$DIR/frontend/dist/.build-hash"
  CURRENT_HASH=$(find "$DIR/frontend/src" "$DIR/frontend/index.html" "$DIR/frontend/vite.config.js" -type f 2>/dev/null | sort | xargs cat 2>/dev/null | hash_stdin)
  PREV_HASH=""
  [ -f "$DIST_STAMP" ] && PREV_HASH=$(cat "$DIST_STAMP")

  if [ ! -d "$DIR/frontend/dist" ] || [ "$CURRENT_HASH" != "$PREV_HASH" ]; then
    echo "  Building frontend..."
    (cd "$DIR/frontend" && npm run build)
    echo "$CURRENT_HASH" > "$DIST_STAMP"
    echo ""
  else
    echo "  Frontend build up to date."
  fi

  # Show token immediately (server banner may take a moment)
  TOKEN_FILE="$HOME/.ive/token"
  if [ -f "$TOKEN_FILE" ]; then
    echo "  Token: $(cat "$TOKEN_FILE")"
    echo ""
  fi

  (cd "$DIR/backend" && "$PYTHON_BIN" server.py "${PASSTHROUGH_ARGS[@]}")
  exit $?
fi

# ── Development mode: two processes ──────────────────────────
echo ""
echo "Starting services (dev mode)..."
echo ""

kill_port 5173

# Start backend
(cd "$DIR/backend" && "$PYTHON_BIN" server.py "${PASSTHROUGH_ARGS[@]}") &
BACKEND_PID=$!

# Wait for backend to be ready (up to 10s)
echo -n "  Waiting for backend..."
for i in $(seq 1 20); do
  if curl -sf http://127.0.0.1:5111/api/workspaces >/dev/null 2>&1; then
    echo " ready"
    break
  fi
  sleep 0.5
done

# Start frontend
(cd "$DIR/frontend" && npm run dev) &
FRONTEND_PID=$!

echo ""
echo "  Backend:  http://127.0.0.1:5111"
echo "  Frontend: http://localhost:5173"
echo ""

cleanup() {
  echo ""
  echo "Shutting down..."
  kill $BACKEND_PID $FRONTEND_PID 2>/dev/null
  # Give processes 2s to exit gracefully, then force-kill
  sleep 2
  kill -9 $BACKEND_PID $FRONTEND_PID 2>/dev/null
  wait $BACKEND_PID $FRONTEND_PID 2>/dev/null
  exit
}

trap cleanup INT TERM
wait
