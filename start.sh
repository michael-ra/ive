#!/bin/bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
DB_PATH="$HOME/.ive/data.db"

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

echo ""
echo "Starting services..."
echo ""

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
kill_port 5173

# Start backend
(cd "$DIR/backend" && python3 server.py) &
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
