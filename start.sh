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
      echo ""
      echo "Examples:"
      echo "  ./start.sh                        # Dev mode (backend + Vite frontend)"
      echo "  ./start.sh --multiplayer           # Production mode with auth"
      echo "  ./start.sh --tunnel                # Production mode + Cloudflare tunnel"
      echo "  npx ive --tunnel                   # Same via npx"
      exit 0
      ;;
    --multiplayer) MULTIPLAYER=true; PASSTHROUGH_ARGS+=("$arg") ;;
    --tunnel) TUNNEL=true; MULTIPLAYER=true; PASSTHROUGH_ARGS+=("$arg") ;;
    --headless) PASSTHROUGH_ARGS+=("$arg") ;;
    --token|--token=*) PASSTHROUGH_ARGS+=("$arg") ;;
    --port|--port=*) PASSTHROUGH_ARGS+=("$arg") ;;
    --host|--host=*) PASSTHROUGH_ARGS+=("$arg") ;;
    *) PASSTHROUGH_ARGS+=("$arg") ;;
  esac
done

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

# Install backend deps (skip if requirements.txt hasn't changed)
STAMP="$DIR/backend/.deps-installed"
if [ ! -f "$STAMP" ] || [ "$DIR/backend/requirements.txt" -nt "$STAMP" ]; then
  echo "Installing backend dependencies..."
  pip3 install -q -r "$DIR/backend/requirements.txt"
  touch "$STAMP"
else
  echo "Backend deps up to date."
fi

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
  CURRENT_HASH=$(find "$DIR/frontend/src" "$DIR/frontend/index.html" "$DIR/frontend/vite.config.js" -type f 2>/dev/null | sort | xargs cat 2>/dev/null | md5 -q 2>/dev/null || md5sum 2>/dev/null | cut -d' ' -f1)
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

  (cd "$DIR/backend" && python3 server.py "${PASSTHROUGH_ARGS[@]}")
  exit $?
fi

# ── Development mode: two processes ──────────────────────────
echo ""
echo "Starting services (dev mode)..."
echo ""

kill_port 5173

# Start backend
(cd "$DIR/backend" && python3 server.py "${PASSTHROUGH_ARGS[@]}") &
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
