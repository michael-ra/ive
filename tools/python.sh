# Sourced by install.sh, start.sh and bin/ive: finds a Python 3.11+ on PATH.
# IVE_PYTHON overrides the search.
ive_python() {
  local candidate
  for candidate in "${IVE_PYTHON:-}" python3.14 python3.13 python3.12 python3.11 python3; do
    [ -n "$candidate" ] && command -v "$candidate" >/dev/null 2>&1 || continue
    if "$candidate" -c 'import sys; sys.exit(sys.version_info < (3, 11))' 2>/dev/null; then
      command -v "$candidate"
      return 0
    fi
  done
  echo "IVE needs Python 3.11 or newer. On macOS: brew install python. On Linux: use your package manager." >&2
  return 1
}
