# IVE for iPhone

A native shell around the IVE web UI. Everything (zsh, Claude Code, Codex)
keeps running on the Mac. The app shows the phone layout of the web UI in a
full-screen web view and adds what a browser tab can't: QR pairing with the
camera, a Face ID lock, haptics on the terminal key bar, no iOS keyboard bar
on top of IVE's own key bar, and a clear screen when the Mac is unreachable.

SwiftUI, iOS 17+, bundle id `eu.aiforeu.ive`. No dependencies.

## Install on your iPhone

1. Open `apps/ios/IVE.xcodeproj` in Xcode.
2. Connect the iPhone with a cable (the first time; afterwards Wi-Fi works too)
   and unlock it. Tap "Trust" on the phone if asked.
3. On the iPhone turn on Developer Mode once: Settings > Privacy & Security >
   Developer Mode, then restart the phone.
4. In Xcode pick your iPhone at the top as the run destination.
5. Target IVE > Signing & Capabilities: pick your own team and change the
   bundle id to one you own, for example `com.yourname.ive`.
6. Press Run (Cmd+R). IVE starts on the phone.

### Which team, and what it means

| Team | Type | What you get |
| --- | --- | --- |
| Apple Developer Program team | paid | App runs for a year per install, TestFlight and App Store possible, Push (APNs) possible |
| Personal Team | free | App stops opening after **7 days** (just press Run again), max 3 apps, no Push |

For Push, also set your team id in IVE under "iPhone & Devices" when you upload
the APNs key.

To hand it to others later: Product > Archive, then upload to TestFlight.

## Pair the phone with the Mac

1. On the Mac in IVE choose "Pair a phone". IVE shows
   a QR code and a link like `http://192.168.1.20:5111/pair#ABCD2345`.
2. In the app tap **Scan QR code** and point the camera at it, or paste the
   link.
3. The app opens that link in its own web view. The one-time code in the
   `#fragment` is redeemed there, and the Mac sets the device cookie
   (`ive_session`) in the app's persistent storage. The app also keeps a copy
   in the Keychain. Done: the overview appears.

The code works once and expires after 5 minutes. Pasting just the address
(`192.168.1.20:5111`) also works: an unpaired phone then sees the Mac's
connect page and can type the code there.

Same Wi-Fi: use the LAN link. Away from home: turn on the tunnel in IVE and
pair with the tunnel link (a quick tunnel gets a new address on every start,
so pair again after a restart).

To disconnect: two-finger double tap anywhere > "Pair again or change Mac".
Revoke the phone fully under Devices in IVE on the Mac.

## What the app does

- **Reconnect screen** when the Mac does not answer (asleep, other network,
  tunnel off, IVE not running), with hints, auto retry every 5 s and a check
  each time the app comes back to the foreground.
- **Face ID lock** on launch and after the app was in the background longer
  than the set time (default 1 minute). Falls back to the device passcode.
  The app switcher shows only the IVE mark. The Mac's own PIN lock (if set)
  comes on top.
- **Pull down to reload** on the overview. Switched off automatically while a
  terminal is on screen, so a swipe never reloads the session.
- **Settings**: two-finger double tap anywhere, or from the reconnect screen.
- Links to other sites open in Safari. Inline media allowed. No link preview
  pop-ups on long press. JS alert/confirm/prompt work.

## For the web UI: `window.iveNative`

Injected only inside the app; the web UI works without it.

```js
if (window.iveNative) {
  iveNative.haptic('light')         // light|medium|heavy|soft|rigid|selection|success|warning|error
  iveNative.setPullToRefresh(false)
  iveNative.openSettings()
  iveNative.openExternal(url)
  iveNative.apnsToken               // APNs token or null
}
```

- `navigator.standalone` is `true` in the app, so the web UI treats it like
  the Home-Screen web app (no install prompt; `/pair.js` jumps to `/` after
  pairing). `<html>` gets the class `ive-native-ios`.
- Taps on `[data-phone-keybar] [data-key]` (the key bar from
  feat/mobile-overview) and on any `[data-native-haptic="style"]` element give
  a haptic tick automatically.
- The user agent ends with `IVE-iOS/<version>` and otherwise looks like iOS
  Safari.

## Push

Web Push does not work inside an app's web view, so the app uses APNs.

- The target has the Push Notifications entitlement
  (`Config/IVE-Debug.entitlements` = `development`,
  `Config/IVE-Release.entitlements` = `production`). `IVEPushEnabled` in
  `Config/Info.plist` is `YES`; set it to `NO` only for a Personal Team build.
- On launch the app registers with APNs silently and, after every page load,
  sends the token to the Mac: `POST /api/phone/apns-token`
  `{token, environment: sandbox|production, bundle_id, device}` with the device
  cookie. The Mac binds it to that paired phone; revoking the phone deletes it.
- Only when the Mac answers `apns_configured: true` does the app ask for
  notification permission.
- A push carries `"path": "/#session-<id>"`; tapping it opens that session
  (also when the tap launches the app).

On the Mac: Settings > iPhone & Devices > "Native push (iPhone app)": pick the
`AuthKey_XXXXXXXXXX.p8` from developer.apple.com (Keys > + > APNs), check the
Key ID, your Team ID and your bundle id, save, then
"Send test". Xcode builds use the sandbox APNs host, TestFlight/App Store
builds production; the app tells the Mac which one.

Simulator: `xcrun simctl push booted eu.aiforeu.ive payload.apns` with a
payload like `{"aps":{"alert":{"title":"t","body":"b"}},"path":"/#session-<id>"}`.
The Simulator can't tap a banner from the command line, so Debug builds accept
`-IVEAutoOpenPushes YES`: a push that arrives while the app is open is then
handled as a tap.

## Build and test without a phone

```sh
cd apps/ios
xcodebuild -scheme IVE -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
```

Launch arguments override the settings, handy in the Simulator:
`-IVEBaseURL http://127.0.0.1:5273 -IVELockEnabled NO`
(the Simulator reaches the Mac's 127.0.0.1; start a sandbox with
`IVE_E2E_PORT=5273 IVE_E2E_KEEP=1 node e2e/serve.mjs` after building the
frontend). Face ID in the Simulator: Features > Face ID > Enrolled, or
`xcrun simctl spawn booted notifyutil -p com.apple.BiometricKit_Sim.pearl.match`.

## Files

- `IVE/IVEApp.swift` root, lock overlay, app switcher cover
- `IVE/ConnectView.swift`, `IVE/QRScannerView.swift` first run and QR scan
- `IVE/MainScreen.swift` web view host and reconnect screen
- `IVE/WebModel.swift` WKWebView setup, navigation, bridge, reachability
- `IVE/NativeBridge.swift` injected JS and keyboard bar removal
- `IVE/AppLock.swift` Face ID lock
- `IVE/CredentialStore.swift` Keychain copy of the device cookie
- `IVE/AppDelegate.swift` APNs registration, permission, notification taps
- `IVE/SettingsView.swift` native settings
- `Config/Info.plist` ATS (local network + web content over http), push flag
- `Config/IVE-*.entitlements` aps-environment per configuration
