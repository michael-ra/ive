# Installing IVE from source

This installation contains the IVE workbench, its Research/Discovery/Delivery/
Secure features, and the optional Sandbox runtime. The package profile selects
only the Sandbox extension from this installation's `extensions/` directory by default.
It does not discover sibling product directories or import existing IVE data.

Requirements: macOS or Linux, Python 3.11+, Node.js 22.12+ with npm, and Git for
workspace operations. Install and start are separate actions:

```bash
bash install.sh --plan       # inspect paths/commands; performs no installation
bash install.sh              # installs dependencies and builds the frontend
bash install.sh --browser    # also installs Chromium for local previews
bash start.sh --plan         # inspect the launch without starting anything
bash start.sh --headless     # start IVE without opening a browser
```

Installation requires network access to package registries. Preview Chromium is
an explicit optional download into this installation's browser cache. The
installer does not install or update coding CLIs, container/VM runtimes, tunnels,
or embedding models. Install the runtimes you intend to use separately. A
requested but unavailable sandbox must report an error, not run on the host.
Process mode is supervised execution, not OS containment.

The first installation claims a new `.ive-team-state/` directory. It refuses
existing unclaimed contents, including a database. Subsequent use keeps this
installation's own database, accounts, attachments, settings, token, and browser
cache there. Do not copy a previous database, config, secrets, or `.env` files
into this package. Do not place it in a directory containing another app's
`.venv` or `frontend/node_modules`. Keep `.ive-team-state`, `.venv`, build output,
and dependencies out of source control and shared source archives.

No `.env` or `.env.local` is read by these launchers or the frontend config. The
launcher discards inherited application/provider variables and fixes the same
profile for the backend and frontend. Configure fresh accounts through IVE.
Use the explicit local configuration below for supported Sandbox settings and
independently reviewed products. Do not restore a development `.env` to enable them.
`frontend/dist/ive-build-profile.json` is checked before starting; a frontend
built for another selection is refused. This marker checks selection parity,
not source integrity or the safety of arbitrary extensions.

## Optional local configuration

`ive-local.json` is an operator-owned file beside `start.sh`, ignored by Git.
Without it, the base selection remains IVE + Sandbox. A minimal example is:

```json
{
  "schema_version": 1,
  "sandbox": {
    "runtime": "docker",
    "container_readonly": true
  },
  "products": []
}
```

Supported Sandbox settings are `runtime` (`none`, `docker`, `apple-container`),
`one_shot_runtime` (`process`, `daytona`), booleans `app_container`,
`browser_container`, `container_readonly`, and image references `docker_image`,
`container_image`, `app_image`, `browser_image`. These configure existing execution
options; they do not install the required runtime. Process execution is not OS
containment. A failed requested containment runtime must not become host execution.
Unknown fields, credential passthrough and security-bypass flags are refused.
The existing Daytona adapter is unavailable: selecting it currently fails
explicitly. Listing the option does not mean a working Daytona integration ships.

Each optional product entry has exactly `id`, `path` and `files`: `path` is the
canonical absolute path of a separate clean package directory named by its id;
`files` maps every package-relative source file (including `extension.json`) to
its reviewed SHA-256 hash. Obtain this inventory from that product's source review,
not by approving an unexamined checkout. Symlinks, state/dependency artifacts,
changed or unlisted files and missing dependencies are refused.  Product code runs with the host's privileges.
This review gate is not a runtime data-access boundary: a separately installed
product may still use its own older data paths or read native memories. Review
and configure that product's state behavior before enabling it; the base package's
no-takeover guarantee does not establish isolation for every optional product.

Run `install.sh --plan` after an explicit selection change, then install/build;
`start.sh` refuses a frontend built for a different selection or product fingerprint.
Declared, reviewed product Python requirements use version pins. The product's
own distribution must supply its code and all additional dependencies; adding an
adapter does not install a separate service or a missing general-purpose library.

Storage API v1 accepts owned declarative JSON, not executable legacy migrations.
On the package's recognized database it creates new product tables/indexes and
declared nullable/defaulted additions on supported host tables or a directly
required product's owned tables in one transaction.
It records the owner, version, content hash and resulting schema. Changed versions,
collisions, rebuilds and data adoption fail explicitly. Disabling a product does
not erase its stored data; deletion and incompatible upgrades are separate actions.

## Native memories and runtime boundaries

IVE's own notes/research start empty and work independently. Native CLI file
access is disabled by default. Import, one-shot synchronization and conflict
resolution ask for confirmation; enabling ongoing synchronization is a separate
choice. Neither simply opening Memory nor starting IVE adopts existing memories.
This controls IVE's import/sync paths, not what a separately launched coding CLI
chooses to read under its own settings and permissions.

The default backend remains local (`127.0.0.1:5111`). Supported backend arguments
can be passed to `start.sh`; networking/multiplayer options remain explicit and
retain the backend's authentication checks. No old process is killed for you.
Installation does not automatically start IVE.

This is separate application state, **not user-home isolation**. Once you choose
to run IVE, its normal local-agent functionality may discover installed CLIs,
use your explicitly selected login, and install its mandatory safety hooks.
Workspace tools and OS keychain access keep their normal host behavior. A
legacy IVE Python runtime can also be discovered as an available workspace
tool. The app safety gate uses this installation's explicit data directory for
its break-glass marker, not another installation's marker.

Direct Python dependency versions are recorded; this is not a fully resolved
hash-locked dependency set.
