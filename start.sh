#!/usr/bin/env bash
set -euo pipefail
IVE_PACKAGE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source "$IVE_PACKAGE_ROOT/tools/python.sh"
IVE_PY="$(ive_python)"
exec "$IVE_PY" -I "$IVE_PACKAGE_ROOT/tools/ive_team.py" --root "$IVE_PACKAGE_ROOT" run "$@"
