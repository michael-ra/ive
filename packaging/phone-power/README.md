# IVE Phone Power helper

This is a narrow macOS 13.5+ Apple Silicon helper for an explicitly enabled,
time-bounded IVE work session, from Mac & Energie or iPhone setup. It is **not installed by building it**. Never
run a registration or power action as part of a build or unattended smoke test.

## Package and sign

```sh
python3 packaging/phone-power/build.py --tests --output packaging/phone-power/.build
python3 packaging/phone-power/build.py --bundle-tests --output packaging/phone-power/.build
python3 packaging/phone-power/build.py --output packaging/phone-power/.build
```

Before signing the containing app, embed:

| Source | App destination |
| --- | --- |
| `.build/ive-phone-power` | `Contents/MacOS/ive-phone-power` |
| `com.ive.desktop.phone-power.plist` | `Contents/Library/LaunchDaemons/com.ive.desktop.phone-power.plist` |

The same executable acts as the CLI and, with the fixed `--daemon` argument,
as the launchd service. Sign its identifier **com.ive.desktop.phone-power** with
Developer ID team **66Y43UAY3C**, hardened runtime and no extra entitlements.
The containing native app must remain **com.ive.desktop** with executable
`Contents/MacOS/ive`. Ad-hoc builds deliberately cannot register or control it.

The backend must launch the helper directly, without `shell=True`, from its own
signed `Contents/Resources/backend/ive-backend` process. The helper verifies the
whole same-UID parent chain to the signed native app in the same app bundle.
CLI↔daemon messages additionally require the helper's signing requirement in
both directions using `NSXPCConnection.setCodeSigningRequirement`.

## Backend contract

Send one JSON object to stdin, close stdin, read one JSON object from stdout.
Never put lease IDs or credentials in arguments. Process exit is zero only when
the response's `ok` is true. Treat `ok:false` as an actual error even if a status
field is present. A client timeout is an unknown outcome: poll status before any
retry, because activation could have succeeded. Never loop start automatically.

| Action | Fields | Behavior |
| --- | --- | --- |
| `status` | optional `app_pid` | Registration or verified daemon status. |
| `register` | optional `app_pid` | Register SMAppService, subject to macOS admin approval. Does not start an awake lease. Idempotent if already registered/awaiting approval. |
| `open-settings` | optional `app_pid` | Open macOS Login Items settings. |
| `start` | required native `app_pid`, explicit `allow_battery`; optional `duration_seconds` | Start only after user consent. Duration defaults to 28800 seconds, valid range 60–28800. |
| `renew` | `app_pid`, `lease_id` | Heartbeat every 10 seconds; lease expires after 30 seconds without renewal. Never extends the hard duration. |
| `stop` | `app_pid`, `lease_id` | Restore normal sleep behavior and verify disk plus kernel state. |
| `unregister` | optional `app_pid` | Refuse unless helper can prove there is no awake/recovery lease. |

Setup/start must remain local-owner-only in the backend; phone clients may see a
redacted status, but must not trigger admin UI or learn `lease_id`. Keep renewal
in the native backend lifecycle, independent of browser tab visibility. Stop on
remote-mode disable/revocation; a backend/app crash also loses renewal and the
native app identity is polled independently. Every new session after a maximum
duration needs another explicit start. An independent Mac & Energie session does
not require a phone tunnel and survives tunnel loss. The backend shares a single
lease between the two entry points and rejects conflicting starts; phone consent
withdrawal does not silently terminate an independently enabled agent session.

## Lid-triggered saving (protocol 2)

`start` optionally accepts `lid_low_power: Bool` and `pause_apps: [String]`.
Legacy phone starts omit both and preserve their previous behavior. The Mac &
Energie screen never starts on load or restores an enabled switch on relaunch.
Its timer starts when the user explicitly enables the function. Arming with an
open lid only establishes the existing awake lease; no low-power setting or app
signal changes until `AppleClamshellState` is explicitly true. Opening the lid
restores all lid actions while the awake timer remains armed. Disabling the mode,
deadline, lost heartbeat, app exit and helper restart restore both layers.

Low Power Mode changes only the battery profile using fixed `pmset -b
lowpowermode 1/0`. AC settings remain untouched. The previous battery value is
journaled before writing and read back after changes. An already enabled profile
stays enabled after reopening. No claimed battery-runtime gain is measured.

App pausing accepts only Slack, Discord, WhatsApp and Spotify bundle IDs listed
in `LidOptions.allowedApps`. No apps are preselected. Only running, non-stopped
processes of the owning UID whose executable is inside a selected outer .app
are eligible. Terminal, browsers, agents, Docker, meeting and recording apps
are not eligible. A PID, UID, start-time and executable identity is journaled
before SIGSTOP; SIGCONT checks that identity again and skips exited/reused PIDs.
Signal results are observed, and status counts actually stopped matching
processes. Apps launched after the lid closes wait until the next close cycle.

The root journal retains failed restorations and the watchdog retries them.
Lid-state uncertainty ends the mode instead of guessing. Optional journal fields
allow old 1.0.5 recovery records to be decoded. Process signals and durable
journal updates are not atomic: another program concurrently stopping the exact
same process cannot be distinguished perfectly. Do not claim exclusive process
ownership or guaranteed recovery if the approved helper is forcibly disabled.

Status names: `not_registered`, `needs_approval`, `not_found`, `unavailable`,
`ready`, `activating`, `active`, `restoring`, `restore_failed`, `blocked`.
Before a service has ever been registered, macOS can return raw `.notFound`.
[Apple DTS describes this ambiguity](https://developer.apple.com/forums/thread/719862).
Only after checking the exact embedded manifest, regular non-symlink paths,
executable presence and Developer ID helper signature does IVE normalize that
case to `not_registered`. It also returns `service_status:not_found` and
`bundle_verified:true` for diagnosis. This means setup is required, not approved
or active. A missing service remains `ok:false/not_found`; a malformed layout or
invalid signature remains `ok:false/unavailable`. No registration is performed
to discover status, and no system settings are reset.
Daemon replies include battery percentage, battery source, floor 20, heartbeat
10, lease 30, maximum duration 28800, reason and protocol version. `expires_at`
and `last_verified_at` are Unix seconds. Lease ID is returned only to its exact
owning app process (UID + PID + process start time + executable path).

## Power scope and recovery

The only power mutations implemented are fixed `/usr/bin/pmset -a disablesleep
1`, its corresponding `0`, battery-only `lowpowermode 1/0`, and narrowly guarded `pmset sleepnow`. There is no
arbitrary command, argument, file path, preference key or privileged code input.

`SleepDisabled` is global, persistent, and broader than closing the lid. A root
owned atomic/fsynced journal is written **before** enabling it at
`/Library/Application Support/IVE/PhonePower/lease.json`. Existing true or
inconsistent flags are not adopted. The initial false/absent behavior is restored
as false; an originally absent preference key may remain explicitly false.

The daemon polls every two seconds, restores on app death, missed heartbeat,
hard duration, battery at/below 20%, serious/critical thermal state, unknown or
stale telemetry, and unexpected external power-setting changes. `allow_battery`
false additionally restores on unplugging. All actual state changes are read
back in both pmset's system preferences and IOPMrootDomain. Exit code alone is
not evidence that pmset changed the setting.

For battery/thermal/telemetry safety cutoffs only, after verified restoration,
the helper reads `AppleClamshellState`. It requests system sleep only if that
Boolean is explicitly true. An open lid never causes forced sleep. An unknown
lid or failed sleep request retains the recovery record and reports
`restore_failed`; normal sleep may already have been restored. Ordinary Stop,
app exit, heartbeat expiry and duration expiry remove the override but do not
force sleep or guarantee immediate lid-sleep.

Launchd keeps the approved service alive; startup restores a previous journal
before accepting another session. No awake session resumes after helper restart
or reboot. An unreadable/unsafe journal blocks activation rather than guessing
ownership. A failed restore retains the journal and is retried by the watchdog.

**Limits:** this is not a public lid-only assertion. A manually disabled/deleted
helper, OS failure, persistent disk/power-management failure or repeated helper
crash can prevent prompt restoration. Another privileged program writing the
same global Boolean cannot be distinguished from IVE by that Boolean alone.
Do not claim perfect co-ownership, guaranteed instant fail-safe recovery, or
that OS emergency sleep is inherently unaffected. The feature must be disabled
and verified restored before moving/removing/updating its installed app.

## Validation boundary

Policy tests use fake adapters only. The native binary compiles for arm64 with
Mach-O minimum macOS 13.5. Read-only guard probes may test malformed/untrusted
invocations, but may not register, install, change sleep, or actually suspend the
machine without the separate authorized in-app user flow.

Remaining real acceptance: Developer-ID-signed client/daemon IPC, macOS approval
and denial, actual lid-close on battery while reaching IVE from iPhone, Stop,
app SIGKILL/helper restart, unplug behavior, and restoration across reboot.
Fake battery/thermal tests do not prove a physical Mac reached those conditions.
