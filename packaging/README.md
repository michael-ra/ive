# IVE macOS distribution

`./packaging/build-macos.sh` produces a self-contained native `IVE.app`, a drag-to-Applications DMG and a ZIP in `packaging/artifacts/`. The build architecture is explicit in the filenames. This first build targets Apple Silicon.

The existing Tauri 2 shell owns a PyInstaller onedir backend, including Python, runtime dependencies, the matching frontend build and the repository's sandbox extension. It does not package development databases, account homes, provider credentials, sibling products, repositories or `node_modules`. Claude Code/Codex, project toolchains and optional Docker remain external prerequisites shown by the app's existing setup checks.

## Build requirements

- macOS with Xcode command-line tools, Rust/Cargo and Node.js 22.12+
- Python for the build bootstrap; `prepare-python.py` downloads the pinned, SHA-256-verified Astral CPython 3.12 runtime (macOS 11 minimum) and creates a private build environment. A host Homebrew Python must not leak a newer OS minimum into the installer. Dependencies and PyInstaller are pinned in `requirements-build.txt`.
- Run from a clean/reviewed checkout. The script uses an isolated build venv and includes the local source state, including intended uncommitted edits. Do not substitute a stale prebuilt backend.

```sh
./packaging/build-macos.sh
```

The bundle manifest records version, source revision, source digest, architecture, Python version and build timestamp. The frontend and backend must be rebuilt together. App/version changes belong in `backend/config.py`, `frontend/src-tauri/Cargo.toml` and `tauri.conf.json`.

## Runtime ownership

The app binds `127.0.0.1:5112`, verifies the launched backend using its instance marker, then loads the UI from the same origin. Relative assets, uploads, exports, preview URLs, HTTP and WebSocket traffic therefore keep working. Browser requests to the desktop service must match its exact local Host and Origin. Starting IVE's own Cloudflare tunnel additionally permits that exact live HTTPS origin through the transport guard, without granting local-owner privileges to the proxy: remote device/session authentication still applies. The backend remains bound to loopback, and remote web pages receive no native Tauri capabilities.

App data lives in `~/Library/Application Support/com.ive.desktop`; no development data is imported. The fixed port preserves browser storage between launches. A busy port produces a visible startup error; IVE never attaches to a random listener. App Quit, window close and SIGTERM shut down only the owned backend, with bounded graceful cleanup. Unexpected backend exit produces a visible diagnostic screen.

The Finder launch restores the user's CLI search path with a bounded shell query and common install locations. Internal MCP/helper commands use the bundled executable and do not depend on a system Python installation.

For isolated tests only, `IVE_DESKTOP_DATA_DIR` (absolute) and `IVE_DESKTOP_PORT` select a separate store and port. The child cannot inherit development IVE/COMMANDER/Python path overrides. Logs and a process/port receipt are written inside the selected data directory.

## Signing and public distribution

The base build is **ad hoc signed, not Apple-notarized**. Downloaded copies of that base build can be blocked by Gatekeeper. Distribution artifacts must subsequently receive a Developer ID signature and Apple notarization; the separate `notarized-release/` artifacts described in `RELEASE-1.0.0-macOS.md` have completed those steps for the app. Do not weaken global Gatekeeper settings.

There are two signing paths. An existing Xcode account with access to a cloud-managed Developer ID certificate can export the app using automatic signing; it does not need a local Developer ID private key or Account Holder login. For local signing, `sign-macos.py` requires an installed Developer ID Application identity with its private key. Both paths work on a separate copy and must verify every embedded Mach-O file, including the Python runtime and Playwright Node, as well as the outer app. Node alone receives the `allow-jit` entitlement. A successful signature is not a notarization result.

Cloud signing uses the existing Xcode account:

```sh
python3 packaging/sign-macos-cloud.py \
  --app packaging/artifacts/installed/IVE.app \
  --output-dir packaging/artifacts/cloud-export-NEW \
  --team-id TEAMID1234 --dry-run
```

Remove `--dry-run` for the cloud export. This adapter creates an archive around the prebuilt app and uses `method=developer-id`, `signingStyle=automatic`, `destination=export`. It was verified with this IVE bundle and Xcode 27. To submit the same archive for notarization, copy its `ExportOptions.plist`, change only `destination` to `upload`, and pass that file to `xcodebuild -exportArchive -archivePath .../IVE.xcarchive -exportOptionsPlist .../NotaryOptions.plist -allowProvisioningUpdates`. Submission is explicit and uploads the app to Apple. Once Apple accepts it, use `xcodebuild -exportNotarizedApp -archivePath .../IVE.xcarchive -exportPath NEW_DIRECTORY` and validate the exported app's stapled ticket before packaging it.

Local signing uses an installed private key:

```sh
python3 packaging/sign-macos.py \
  --app packaging/artifacts/installed/IVE.app \
  --identity 'Developer ID Application: COMPANY (TEAMID1234)' \
  --dry-run
```

Remove `--dry-run` to sign a new output directory. For local signing, adding `--notary-profile PROFILE` explicitly submits the app archive and DMG using an existing `notarytool` keychain profile, requires Apple's `Accepted` result, staples the tickets and checks Gatekeeper. Existing output directories are never overwritten. No signing script stores passwords or changes keychain permissions.

Verify the final downloaded app and DMG using `codesign`, `spctl` and `xcrun stapler validate`. Apple's cloud-certificate requirements are documented at https://developer.apple.com/help/account/certificates/cloud-managed-certificates/; Tauri's macOS signing guide is https://v2.tauri.app/distribute/sign/macos/. No update endpoint or automatic updater is configured in this preview. Neither signing credentials nor service API keys belong in this repository or the bundle.

## Verification

Keep installer-specific evidence under `packaging/artifacts/` (ignored). Check the frozen backend in a fresh data directory, internal MCP startup, app-owned start/stop/restart, persistent data, occupied port behavior, matching source/resource manifest, DMG mount/install, architecture and code signature. Browser checks use the Playwright plugin against the app's own local backend. A passing browser check is not a claim that every WebKit/native permission or external integration was exercised.

## iPhone availability helper

The 1.0.5 app includes `Contents/MacOS/ive-phone-power` and its SMAppService LaunchDaemon plist. The helper must retain signing identifier `com.ive.desktop.phone-power` and Developer ID team `66Y43UAY3C`; both ends of XPC validate the requirement. The client additionally validates its bundled-backend/native-app parent chain. Compile with `python3 packaging/phone-power/build.py --output packaging/build/phone-power`; this command never registers a service or changes power settings.

Registration and activation are separate, local-owner-only actions from the iPhone setup screen. Consent records are not evidence of macOS approval or a running lease. The daemon holds an eight-hour maximum lease with a ten-second backend heartbeat and thirty-second expiry; no lease credential is returned to browsers. Recovery restores normal sleep after app exit, heartbeat loss or daemon restart. All native execution and battery/thermal/closed-lid behavior require separate signed-app acceptance. Unit fixtures never grant OS permission or change the host's power settings.

Before replacing an installed app that already owns an availability session, stop that session and verify normal sleep restoration. Never move or remove its active service bundle to clean up build copies. Build/export/test app copies should be unregistered and removed after verifying the canonical `/Applications/IVE.app` and final DMG, so macOS app search does not accumulate duplicate IVE entries.
