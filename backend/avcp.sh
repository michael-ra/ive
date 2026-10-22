# AVCP — Agent/Vibe-Coding Command Protection. IVE's supply-chain guard for package installs.
#
# Gates `install`-style subcommands of npm/pnpm/yarn/pip/uv/brew/cargo/bun/bundle/gem/go: it LOGS
# every gated command (audit trail = supply-chain visibility), PROMPTS in an interactive shell,
# and in a NON-interactive shell (agents / CI) logs-and-allows so automation never hangs. Every
# function is defined EAGERLY (not zsh-autoloaded) so shell-snapshot tools (e.g. Claude Code's
# Bash) capture `_avcp_check` — the autoloaded version is why `npm install` errored under agents.
#
# Source from your shell rc (the IVE installer adds the line; see avcp_installer.py).
#   Toggle:  avcp-on [--global] | avcp-off [--global] | avcp-status
#   Session off: export AVCP_DISABLED=1
#   Audit log:   $_AVCP_LOG (default ~/.ive/avcp.log)

: "${_AVCP_GLOBAL_FILE:=$HOME/.ive/avcp-global}"
: "${_AVCP_LOG:=$HOME/.ive/avcp.log}"

_avcp_is_active() {
  [ "${AVCP_DISABLED:-0}" = "1" ] && return 1
  [ -f "$_AVCP_GLOBAL_FILE" ] && return 0
  _avcp_d=$PWD
  while [ -n "$_avcp_d" ] && [ "$_avcp_d" != "/" ]; do
    [ -f "$_avcp_d/.avcp" ] && return 0
    _avcp_d=$(dirname "$_avcp_d")
  done
  return 1
}

_avcp_check() {
  _avcp_is_active || return 0            # protection off -> allow silently
  _avcp_tool=$1; shift
  _avcp_cmd="$_avcp_tool $*"
  mkdir -p "$(dirname "$_AVCP_LOG")" 2>/dev/null
  printf '%s\t%s\t%s\n' "$(date +%FT%T 2>/dev/null)" "$PWD" "$_avcp_cmd" >> "$_AVCP_LOG" 2>/dev/null
  if [ -t 0 ] && [ -t 1 ]; then         # interactive -> confirm
    printf '[avcp] gate: %s\n[avcp] allow? (y/N) ' "$_avcp_cmd" >&2
    read -r _avcp_ans
    case "$_avcp_ans" in
      y | Y | yes | YES) return 0 ;;
      *) echo "[avcp] blocked." >&2; return 1 ;;
    esac
  fi
  return 0                              # non-interactive (agent/CI) -> logged + allowed
}

avcp-on() {
  if [ "$1" = "--global" ] || [ "$1" = "-g" ]; then
    mkdir -p "$(dirname "$_AVCP_GLOBAL_FILE")" 2>/dev/null; : > "$_AVCP_GLOBAL_FILE"
    echo "[avcp] enabled globally (all dirs). disable: avcp-off --global" >&2
  else
    : > .avcp; echo "[avcp] enabled for $PWD. disable: avcp-off" >&2
  fi
}
avcp-off() {
  if [ "$1" = "--global" ] || [ "$1" = "-g" ]; then
    rm -f "$_AVCP_GLOBAL_FILE"; echo "[avcp] global protection disabled." >&2
  elif [ -f .avcp ]; then
    rm -f .avcp; echo "[avcp] disabled for $PWD." >&2
  else
    export AVCP_DISABLED=1; echo "[avcp] disabled for this session." >&2
  fi
}
avcp-status() {
  if [ "${AVCP_DISABLED:-0}" = "1" ]; then echo "[avcp] disabled (session override)" >&2
  elif [ -f "$_AVCP_GLOBAL_FILE" ]; then echo "[avcp] active globally" >&2
  elif _avcp_is_active; then echo "[avcp] active (.avcp marker)" >&2
  else echo "[avcp] inactive in $PWD. enable: avcp-on" >&2; fi
}

# Package-manager wrappers — gate install-like subcommands, then exec the real tool.
typeset -f npm >/dev/null 2>&1 || function npm { case "$1" in install | i | add | update | upgrade | ci) _avcp_check npm "$@"    || return 1 ;; esac; command npm "$@"; }
typeset -f pnpm >/dev/null 2>&1 || function pnpm { case "$1" in install | i | add | update | up)           _avcp_check pnpm "$@"   || return 1 ;; esac; command pnpm "$@"; }
typeset -f yarn >/dev/null 2>&1 || function yarn { case "$1" in add | install | up | upgrade)              _avcp_check yarn "$@"   || return 1 ;; esac; command yarn "$@"; }
typeset -f pip >/dev/null 2>&1 || function pip { case "$1" in install)                                   _avcp_check pip "$@"    || return 1 ;; esac; command pip "$@"; }
typeset -f pip3 >/dev/null 2>&1 || function pip3 { case "$1" in install)                                   _avcp_check pip3 "$@"   || return 1 ;; esac; command pip3 "$@"; }
typeset -f uv >/dev/null 2>&1 || function uv { case "$1" in add | pip)                                 _avcp_check uv "$@"     || return 1 ;; esac; command uv "$@"; }
typeset -f brew >/dev/null 2>&1 || function brew { case "$1" in install | upgrade)                         _avcp_check brew "$@"   || return 1 ;; esac; command brew "$@"; }
typeset -f cargo >/dev/null 2>&1 || function cargo { case "$1" in add | install)                             _avcp_check cargo "$@"  || return 1 ;; esac; command cargo "$@"; }
typeset -f bun >/dev/null 2>&1 || function bun { case "$1" in add | install | i | update)                _avcp_check bun "$@"    || return 1 ;; esac; command bun "$@"; }
typeset -f bundle >/dev/null 2>&1 || function bundle { case "$1" in install | add | update)                    _avcp_check bundle "$@" || return 1 ;; esac; command bundle "$@"; }
typeset -f gem >/dev/null 2>&1 || function gem { case "$1" in install | update)                          _avcp_check gem "$@"    || return 1 ;; esac; command gem "$@"; }
typeset -f go >/dev/null 2>&1 || function go { case "$1" in get | install)                             _avcp_check go "$@"     || return 1 ;; esac; command go "$@"; }
