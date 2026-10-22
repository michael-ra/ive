#!/usr/bin/env bash
# IVE installer.
#
#   curl -fsSL https://ive.dev/install.sh | bash
#
# Downloads IVE from GitHub into ~/.ive, installs its Python and npm
# dependencies there, builds the app and links an `ive` command into
# ~/.local/bin. Running it again updates an existing installation.
# Nothing outside those two places is changed and IVE is not started.
#
# Settings: IVE_DIR (install folder), IVE_BIN_DIR (where `ive` goes),
# IVE_REPO (git URL to install from), IVE_PYTHON (Python to use).

# Everything runs inside main so a half-downloaded script does nothing.
main() {
  set -euo pipefail
  local repo="${IVE_REPO:-https://github.com/michael-ra/ive.git}"
  local dir="${IVE_DIR:-$HOME/.ive}"
  local bin_dir="${IVE_BIN_DIR:-$HOME/.local/bin}"
  local updated=""

  case "$(uname -s)" in
    Darwin|Linux) ;;
    *) fail "IVE runs on macOS and Linux." ;;
  esac

  need git "Install Git first. On macOS: xcode-select --install"
  need node "Install Node.js 22.12 or newer first: https://nodejs.org (on macOS: brew install node)"
  need npm "Install npm (it comes with Node.js)."
  node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 12) ? 0 : 1)' \
    || fail "IVE needs Node.js 22.12 or newer, you have $(node -v). On macOS: brew upgrade node"

  if [ -d "$dir/.git" ] && [ -f "$dir/bin/ive" ]; then
    # Stops a running IVE, updates, rebuilds and starts it again.
    say "Updating IVE in $dir"
    bash "$dir/bin/ive" update
    updated=1
  elif [ -d "$dir/.git" ]; then
    say "Updating IVE in $dir"
    git -C "$dir" pull --ff-only --quiet
  elif [ -e "$dir" ]; then
    fail "$dir already exists and is not an IVE folder. Choose another one with IVE_DIR=/some/path."
  else
    say "Downloading IVE into $dir"
    git clone --quiet --depth 1 "$repo" "$dir"
  fi

  # The Python check lives in the repo so it can't drift from install.sh.
  source "$dir/tools/python.sh"
  ive_python >/dev/null || exit 1

  if [ -z "${updated:-}" ]; then
    say "Installing dependencies and building the app. This takes a few minutes."
    bash "$dir/install.sh"
  fi

  mkdir -p "$bin_dir"
  ln -sfn "$dir/bin/ive" "$bin_dir/ive"

  say ""
  say "IVE is installed."
  case ":$PATH:" in
    *":$bin_dir:"*)
      say "Start it with:  ive"
      say "IVE then runs in the background and opens in your browser."
      ;;
    *)
      say "Start it with:  $bin_dir/ive"
      say "To type just 'ive', add this line to your shell profile (~/.zshrc or ~/.bashrc):"
      say "  export PATH=\"$bin_dir:\$PATH\""
      ;;
  esac
  say "Stop it with 'ive stop', update with 'ive update', remove it with 'ive uninstall'."
}

say() { printf '%s\n' "$*"; }
fail() { printf 'IVE install: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "$2"; }

main "$@"
