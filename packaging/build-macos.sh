#!/bin/bash
# Build a self-contained app for the architecture of this Mac. No user state is copied.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"
# Keep the builder's home folder out of panic paths in the shipped binary.
export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$HOME=~"
cd "$ROOT"
if [[ "$(uname -s)" != Darwin ]]; then echo 'Build this installer on macOS.' >&2; exit 1; fi
command -v cargo >/dev/null || { echo 'Install the Rust toolchain from https://rustup.rs first.' >&2; exit 1; }
command -v node >/dev/null || { echo 'Node.js 22.12+ is required to build (not to run IVE).' >&2; exit 1; }
PYTHON="$(python3 packaging/prepare-python.py)"
"$PYTHON" packaging/prepare-cloudflared.py
"$PYTHON" packaging/phone-power/build.py --output packaging/build/phone-power
mkdir -p packaging/artifacts
"$PYTHON" -m venv --clear packaging/.venv
packaging/.venv/bin/python -m pip install -r packaging/requirements-build.txt
(cd frontend && npm ci && npm run build)
packaging/.venv/bin/python -m PyInstaller --noconfirm --clean --distpath packaging/dist --workpath packaging/build packaging/ive-backend.spec
cargo fetch --locked --manifest-path frontend/src-tauri/Cargo.toml
packaging/.venv/bin/python packaging/collect-notices.py
# beforeBuildCommand intentionally disabled here: the identical frontend just
# embedded in the backend must also be the one included by the desktop shell.
(cd frontend && npm run tauri build -- --bundles app --config '{"build":{"beforeBuildCommand":""}}')
APP="$ROOT/frontend/src-tauri/target/release/bundle/macos/IVE.app"
mkdir -p "$APP/Contents/Library/LaunchDaemons"
cp packaging/build/phone-power/ive-phone-power "$APP/Contents/MacOS/ive-phone-power"
cp packaging/phone-power/com.ive.desktop.phone-power.plist "$APP/Contents/Library/LaunchDaemons/"
# The helper is compiled/signed separately; seal the added bundle resources.
# Registration and system power changes happen only after explicit app setup.
/usr/bin/codesign --force --sign - --options runtime "$APP"
packaging/.venv/bin/python packaging/verify-bundle.py --bundle "$APP" --max-macos 13.5 --report packaging/artifacts/bundle-audit.json
ARCH="$(uname -m)"
VERSION="$(node -p 'JSON.parse(require("fs").readFileSync("frontend/src-tauri/tauri.conf.json")).version')"
DEST="$ROOT/packaging/artifacts/IVE-$VERSION-macOS-$ARCH"
# A standard drag-to-Applications DMG without Finder scripting / UI automation.
STAGE="$(mktemp -d /tmp/ive-dmg.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT
/usr/bin/ditto "$APP" "$STAGE/IVE.app"
ln -s /Applications "$STAGE/Applications"
cp packaging/DMG-README.txt "$STAGE/Read me.txt"
/usr/bin/hdiutil create -volname IVE -srcfolder "$STAGE" -ov -format UDZO "$DEST.dmg"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$APP" "$DEST.zip"
/usr/bin/codesign --verify --deep --strict "$APP"
/usr/bin/shasum -a 256 "$DEST.dmg" "$DEST.zip" > "$DEST.sha256"
echo "Created: $DEST.dmg"
echo "Created: $DEST.zip"
