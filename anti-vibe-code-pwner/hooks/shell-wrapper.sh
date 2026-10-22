#!/bin/bash
# AVCP shell wrappers — source this in your .bashrc / .zshrc
#
# Wraps pip, npm, yarn, pnpm, bun, cargo, go, gem, composer, brew
# with pre-install security checks.
#
# Scope:
#   By default, only active in directories with a .avcp marker file.
#   Use `avcp-on` in a project dir to enable, `avcp-on --global` for everywhere.
#
# Install via: avcp setup shell

_AVCP_BIN="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)/avcp"
_AVCP_THRESHOLD="${AVCP_THRESHOLD:-7}"
_AVCP_GLOBAL_FILE="${HOME}/.avcp_global"

# ── Scope check: is AVCP active in the current directory? ──

_avcp_is_active() {
  # Explicitly disabled → off
  [[ "${AVCP_DISABLED:-0}" == "1" ]] && return 1

  # Global mode → always on
  [[ -f "$_AVCP_GLOBAL_FILE" ]] && return 0

  # Per-directory: walk up to find .avcp marker
  local dir="$PWD"
  while [[ "$dir" != "/" ]]; do
    [[ -f "$dir/.avcp" ]] && return 0
    dir="$(dirname "$dir")"
  done

  # No marker found → not active
  return 1
}

# ── Toggle commands ──

avcp-on() {
  if [[ "$1" == "--global" || "$1" == "-g" ]]; then
    touch "$_AVCP_GLOBAL_FILE"
    echo "[avcp] Enabled globally (all directories). Disable: avcp-off --global" >&2
  else
    touch .avcp
    echo "[avcp] Enabled for $(pwd). Disable: avcp-off" >&2
    echo "       For all directories: avcp-on --global" >&2
  fi
}

avcp-off() {
  if [[ "$1" == "--global" || "$1" == "-g" ]]; then
    rm -f "$_AVCP_GLOBAL_FILE"
    echo "[avcp] Global protection disabled." >&2
  elif [[ -f .avcp ]]; then
    rm -f .avcp
    echo "[avcp] Disabled for $(pwd)." >&2
  else
    # Quick disable for current session
    export AVCP_DISABLED=1
    echo "[avcp] Disabled for this terminal session." >&2
  fi
}

avcp-status() {
  if [[ "${AVCP_DISABLED:-0}" == "1" ]]; then
    echo "[avcp] Disabled (session override)" >&2
  elif [[ -f "$_AVCP_GLOBAL_FILE" ]]; then
    echo "[avcp] Active globally" >&2
  elif _avcp_is_active; then
    echo "[avcp] Active (found .avcp marker)" >&2
  else
    echo "[avcp] Inactive in $(pwd). Enable: avcp-on" >&2
  fi
}

# ── Core check function ──

_avcp_check() {
  local cmd="$*"
  _avcp_is_active || return 0

  if [[ ! -x "$_AVCP_BIN" ]]; then
    echo "[avcp] Warning: avcp binary not found at $_AVCP_BIN" >&2
    return 0
  fi

  local result
  result=$("$_AVCP_BIN" intercept "$cmd" --threshold "$_AVCP_THRESHOLD" 2>/dev/null) || return 0

  local decision
  decision=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('decision','allow'))" 2>/dev/null) || return 0

  if [[ "$decision" == "block" ]]; then
    local reason
    reason=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reason',''))" 2>/dev/null)
    echo ""
    echo -e "\033[0;31m[AVCP] BLOCKED\033[0m $reason"
    echo ""
    echo -e "  Override: \033[0;36mAVCP_DISABLED=1 $cmd\033[0m"
    echo -e "  Details:  \033[0;36mavcp intercept \"$cmd\" --verbose\033[0m"
    echo ""
    return 1
  elif [[ "$decision" == "warn" ]]; then
    local reason
    reason=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reason',''))" 2>/dev/null)
    echo ""
    echo -e "\033[1;33m[AVCP] WARNING\033[0m $reason"
    echo ""
    echo -e "  \033[1;33mProceed? [y/N]\033[0m"
    read -r confirm
    if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
      echo -e "\033[0;31m  Aborted.\033[0m"
      return 1
    fi
  fi

  return 0
}

# ── Wrapped commands ──

pip() {
  if [[ "$1" == "install" ]]; then
    _avcp_check pip "$@" || return 1
  fi
  command pip "$@"
}

pip3() {
  if [[ "$1" == "install" ]]; then
    _avcp_check pip3 "$@" || return 1
  fi
  command pip3 "$@"
}

npm() {
  case "$1" in
    install|i|add|update|upgrade)
      _avcp_check npm "$@" || return 1
      ;;
  esac
  command npm "$@"
}

yarn() {
  case "$1" in
    add|install|upgrade|up)
      _avcp_check yarn "$@" || return 1
      ;;
  esac
  command yarn "$@"
}

pnpm() {
  case "$1" in
    add|install|i|update|upgrade)
      _avcp_check pnpm "$@" || return 1
      ;;
  esac
  command pnpm "$@"
}

bun() {
  case "$1" in
    add|install|i|update)
      _avcp_check bun "$@" || return 1
      ;;
  esac
  command bun "$@"
}

cargo() {
  case "$1" in
    add|install)
      _avcp_check cargo "$@" || return 1
      ;;
  esac
  command cargo "$@"
}

go() {
  case "$1" in
    get|install)
      _avcp_check go "$@" || return 1
      ;;
  esac
  command go "$@"
}

gem() {
  if [[ "$1" == "install" ]]; then
    _avcp_check gem "$@" || return 1
  fi
  command gem "$@"
}

bundle() {
  case "$1" in
    install|add|update)
      _avcp_check bundle "$@" || return 1
      ;;
  esac
  command bundle "$@"
}

composer() {
  case "$1" in
    require|install|update|upgrade)
      _avcp_check composer "$@" || return 1
      ;;
  esac
  command composer "$@"
}

brew() {
  case "$1" in
    install|upgrade)
      _avcp_check brew "$@" || return 1
      ;;
  esac
  command brew "$@"
}

# ── Startup message ──

if [[ -f "$_AVCP_GLOBAL_FILE" ]]; then
  echo "[avcp] Supply chain protection active (global). Toggle: avcp-off --global" >&2
elif [[ "${AVCP_DISABLED:-0}" != "1" ]]; then
  echo "[avcp] Supply chain protection loaded. Enable per-project: avcp-on | Global: avcp-on --global" >&2
fi
