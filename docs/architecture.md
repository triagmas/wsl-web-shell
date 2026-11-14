# Architecture

Implementation notes for M1 (`R00` + `R01`). The product contract lives in
[spec.md](spec.md); the upstream backend contract in
[upstream-dsh-web.md](upstream-dsh-web.md).

## Process model

```text
Windows
└─ DSH WSL.exe (Electron main + isolated Chromium renderers)
   ├─ Supervisor (main process, no renderer code)
   │  ├─ wsl.exe gateway: distro list/start, dsh resolution, spawn, /proc probe, signals
   │  ├─ loopback port probe + owned-PID registry (userData/owned-server.json)
   │  └─ health loop (10 s visible / 25 s hidden, two failures => recovery)
   ├─ splash window  : frameless local page, orbital loader + error/retry
   ├─ settings window: local page, validated patch -> config.json
   ├─ popover window : frameless local page, same validated patch path
   └─ main window    : app-owned footer bar (local page + chrome preload)
        └─ WebContentsView: partition "persist:wsl-web-shell", no preload, sandboxed
             ⇅ http://127.0.0.1:<port>
      Ubuntu (existing) → dsh web --host 127.0.0.1 --port <port> --no-open
```

Everything under `src/main/core/` is Electron-free and unit-tested; Electron
integration is limited to `src/main/electron/*` and `src/main/index.ts`.

## Lifecycle

`CHECKING → STARTING_WSL → STARTING_WEB → CONNECTING → READY ↔ HIDDEN_IN_TRAY`,
plus `RECOVERING`, `ERROR`, `QUITTING`. `src/main/core/lifecycle.ts` holds the
transition allowlist; illegal jumps throw instead of silently mutating state.

All entry points (`start`, `restart`, `retry`, `shutdown`) go through one promise
chain, so two launches can never spawn two servers. `start()` is also idempotent
while a backend is already owned and healthy.

### Isolated backend environment

The backend never inherits a shared harness home. Every launch derives one
validated root — `~/.local/share/wsl-web-shell` by default — and puts
`DSH_HOME`, `DSH_AGENTS_HOME`, caches, temp files and the test workspace below it
(`src/main/core/isolation.ts`):

| Path | Purpose |
|---|---|
| `<root>/dsh-home` | `DSH_HOME`: harness config, credentials, sessions |
| `<root>/agents` | `DSH_AGENTS_HOME`: keeps the shared `~/.agents` out of the backend |
| `<root>/cache`, `<root>/tmp` | `XDG_CACHE_HOME`, `TMPDIR` |
| `<root>/workspace` | test workspace used when the configured workspace is the bare `~` |

An empty `<root>/update` directory may remain from older versions; the app no
longer writes to it. Since issue #17 this is **data** isolation only: the
executable is not stored here. An older `<root>/runtime/bin` copy may still exist on disk; it is reported
(`legacy=yes`) and never selected.

**Root rules.** The root must be a dedicated, application-owned subtree at least
two components deep. `/`, `~`, `~/`, `~/x`, `/srv`, `~user/...`, empty or
repeated separators, `.`/`..` segments and any shell-significant character
(space, quote, `$`, `;`, `|`, `&`, backslash) are rejected in the TypeScript
validator **and** again inside the distribution before the first write. A root
equal to the home directory is rejected as well. Trailing slashes are normalised
away so the launcher and the plan always see the same string.

**Symlink rules.** Before anything is created, every component from the home
directory (or from `/` for absolute roots) down to the root is checked with
`-L`; the root itself and every managed subdirectory are re-checked before and
after `mkdir -p`, and each created directory must canonicalise to its expected
path (`cd … && pwd -P`). A symlink anywhere in that chain fails the launch with
its own exit code instead of silently redirecting writes outside the tree.

**Preparation** (`mkdir -p`, `umask 077`) is the only write the shell performs
inside the distribution, it is confined to the validated root, and it never
changes or removes pre-existing content — an existing `dsh-home` keeps its files
and modes.

**Environment delivery.** Variables are exported *inside* the distribution by the
start wrapper, so `~` expands against the Linux home and nothing depends on
`WSLENV` forwarding from Windows. Only the resolved `node` directory is prepended
to `PATH` — never a private runtime prefix — and the wrapper re-validates the root
and re-checks the managed directories, so it can never launch against a root that
changed after preparation.

The `PATH` entry is added **whether or not data isolation is enabled** (issue
#24): an npm-installed `dsh` is a `#!/usr/bin/env node` shim and
`wsl.exe --exec /bin/bash` starts with a minimal PATH that does not contain
`~/.local/bin`, so tying the entry to isolation made the backend die with exit 127
as soon as the toggle was turned off. With isolation off the wrapper exports none
of the `DSH_*`/cache/temp variables, `~` is the normal Linux home and the harness
reads the user's own `~/.dsh`; turning it back on returns to the isolated root.
Nothing is ever copied or merged between the two.

**Which `dsh` runs (issue #17).** `RESOLVE_RUNTIME_SCRIPT` prefers exactly what an
ordinary terminal would find: a pinned path from Settings, then
`bash -lc 'command -v dsh'`, then the `--exec` PATH, then the conventional
install locations. The result is reported with its source, and the provenance
(realpath, npm prefix, manager, writability, foreign processes) is inspected only
when the update window opens. The app never installs, copies or prefers its own
`dsh`; when none is found it shows an actionable install instruction instead.

**Working directory.** `wsl.exe --cd` is not used: whether it expands a
tilde-prefixed subpath depends on the WSL build, and the shell has to resolve
`~` anyway. The wrapper enters the workspace itself (`cd`), treating `~` as the
isolated workspace when isolation is on, and fails with a distinct message when
the directory is missing or is not a directory. Workspace values with `.`/`..`
segments or empty components are rejected.

**Limits — this is not an OS sandbox.** Isolation covers environment variables,
the npm prefix, caches and temp files. npm lifecycle scripts, `dsh` tools and any
command the WebUI user starts still run with the owner's Linux user permissions;
nothing prevents such a process from writing elsewhere in the distribution. The
guarantee is scoped to what this app itself creates and launches.

### Window and tray state

Window `show`/`hide` events feed `Supervisor.markHidden()`, so `READY` and
`HIDDEN_IN_TRAY` always reflect what the user sees; closing the window (X) moves
the state to `HIDDEN_IN_TRAY` while supervision continues (health checks slow to
25 s).

The visibility policy is pure (`src/main/core/visibility.ts`) and enforced in the
main process:

- the first successful start honours `openOnLaunch`; afterwards a window the user
  hid is **never** re-shown by a later `READY`;
- the always-on-top splash is activated only when the app window is on screen, so
  a hidden app never pops a window over the desktop during recovery or failure;
- tray Open routes to the overlay when there is nothing loadable yet (`ERROR`,
  `RECOVERING`), otherwise to the window;
- recovery restores the tray state it started from: a hidden app recovers into
  `HIDDEN_IN_TRAY`, not `READY`.

### Reconnection after a restart

`Supervisor.readyGeneration` increments on every successful connect. When the
generation changes the window layer calls `loadBackend(origin, { force: true })`,
which reloads the original WebUI even though the URL is unchanged — the document
behind it belongs to a dead backend session. Navigations are serialized through a
single in-flight promise, so a recovery burst cannot race two loads; no substitute
UI and no injected styles are involved, and DSH session state stays server-side.

### Manual update (issue #12)

The app does not update DeepSeek Harness. It observes the installation and renders
instructions, split the usual way:

- `src/main/core/manual-update.ts` — pure `buildManualUpdatePlan()`: exact-version
  guard, manager-specific install line, stop/install/start order for a discovered
  unit, and a refusal (no command) when the manager, installed version or target is
  unknown;
- `src/main/wsl/inspect.ts` — the read-only inspection script (`INSPECT_SCRIPT`) and
  its argv construction; it reports paths, versions, manager, prefix, writability and
  foreign processes, and never writes;
- `src/main/wsl/managed.ts` — read-only cgroup lookup for the systemd unit behind an
  attached backend; discovery only, no `systemctl` and no `sudo`;
- `src/main/index.ts` — builds the plan from a fresh inspection and the supervisor's
  ownership state (`owned`, `attached`, `none`) and exposes `update:probe`,
  `update:recheck`, `update:run`, `update:close`;
- `src/main/core/update-console.ts` — pure: `buildUpdateScript()` (bash text, log path,
  first-failure status, guaranteed `start` after `stop`), `buildUpdateResult()` (the
  verdict the window shows, decided by the version read afterwards) and
  `planRunsInConsole()`;
- `src/main/wsl/console.ts` — spawns `wsl.exe -d <distro> --exec /bin/bash -c …` with
  `windowsHide: false`, no `detached`, and waits for the exit event;
- `src/main/core/supervisor.ts` — `suspendForUpdate()` / `resumeAfterUpdate()`: the
  pause flag that keeps recovery, health checks, hand-back and the keepalive re-arm
  away from a backend a console update owns;
- `src/update/*` + `src/preload/update.ts` — the window that renders facts, commands,
  per-line **Copy** / **Copy all**, the **Run in WSL console** button and the result.

`update:recheck` runs the inspection again instead of reading a cache, so the window
reflects a command the owner just ran. `update:run` is the only channel that executes
anything: it runs exactly the shown list in a visible console, with the supervisor
paused, and re-reads the installation afterwards. Nothing in the app process calls
`sudo`, `systemctl`, npm or pnpm.

## Ownership

A server counts as app-owned only when all of the following hold:

1. a record exists in the app profile with matching preset, distro and port;
2. the recorded Linux PID is alive and its `/proc/<pid>/stat` start time matches
   the recorded value (PID-reuse guard);
3. its command line still contains the `dsh` marker, the `web` profile, our
   `--host 127.0.0.1` and our `--port`.

Port reachability never grants ownership. An occupied port without a verified
record is a collision: the shell fails closed, shows the port and the remedy, and
touches nothing.

Loss handling keeps the ownership data. A recovery first **reclaims** the
app-owned process — verified, `SIGTERM`, then `SIGKILL` — before the port is
probed again, so a hung-but-alive backend can never survive a failed recovery and
an occupied port afterwards is necessarily somebody else's listener (collision).
A process that already died is simply forgotten; a PID whose start time no longer
matches is never signalled.

Recovery is **serialized with manual starts and tied to a backend generation**
(issue #24). Every spawned backend gets a monotonic generation; an exit event is
only acted on while it still belongs to the current generation, so a late event
from a replaced backend can neither trigger a recovery nor make the replacement
look dead. While a start is in flight the start owns the outcome: the exit
handler stays out of the way and duplicate recovery requests (an exit event plus
a failing health tick for the same process) collapse into one loop. A backend
that dies during startup therefore produces exactly one attempt with the exit
code and the last stderr lines (`#!/usr/bin/env node` failures show up there),
not a retry storm or a generic "could not be verified" message.

`SIGKILL` is a last resort and is re-validated twice immediately before it is
sent: PID, `/proc/<pid>/stat` start time and command line must still match the
recorded backend, otherwise the escalation is withheld (PID-reuse protection).
Finally the Windows-side `wsl.exe` launcher handle is closed. No `wsl --shutdown`,
no `taskkill`, no port-wide kills.

## Token handling

The `dsh web:` line is parsed in `src/main/backend/urls.ts` against the fixed
origin. The tokenized URL is consumed by `ses.fetch` in the isolated session
(cookie jar), which answers with the signed session cookie and a redirect to
`./`; the renderer only ever navigates to `http://127.0.0.1:<port>/`. The token
is never written to logs, UI, dialog text or status snapshots — `redactSecrets`
runs on every log line and the token never leaves the module's local scope.

## Window hardening

Since issue #9 the remote backend page is no longer the window itself: the window
hosts the app-owned footer bar (local `file://` page, `chrome` preload) and the
WebUI lives in a `WebContentsView` sized to `computeViewBounds(contentWidth,
contentHeight)` — exactly the window content minus the 32 px bar. The view is
re-laid out on resize/maximize/restore/fullscreen and destroyed with the window,
so no remote content ever shares a document with app chrome. The bar is never
`alwaysOnTop`, never overlays the page and injects nothing into it
(`docs/footer.md`).

The view has a lifetime independent of the window: `READY` loads the WebUI
before anything is shown, so on a cold start the view exists while no window
does. `ensureBackendView()` therefore attaches the view whenever a window is
present *and* `ensureMain()` re-attaches an already existing view, and every
"visible again" path (show, ready-to-show, footer load, display change) calls
`syncBackendView()`, which re-attaches missing views, keeps the WebUI the
top-most child and re-applies `computeViewBounds`. Skipping any of those steps
leaves a loaded but unattached surface: the backend is healthy, the bar renders
and the window shows only the app-owned page (issue #11).

Backend view: `nodeIntegration:false`, `contextIsolation:true`,
`sandbox:true`, `webSecurity:true`, no preload, `webviewTag:false`, menu bar
hidden, devtools available only to the developer. The main window adds no
further privileges: its page is local, its preload exposes only named footer
channels, and it may not navigate away from `file://` or open windows.

- `will-navigate` / `will-redirect`: only the exact configured origin.
- `setWindowOpenHandler`: popups denied; safe public HTTPS links are handed to
  the system browser, loopback/LAN/literal-IP targets are refused.
- Permission handler allowlist: `fullscreen`, `clipboard-sanitized-write` only.
- Downloads are cancelled; `will-attach-webview` is refused.
- Close (X) hides to tray; only the tray Quit path destroys windows.

Splash and settings windows are local `file://` pages with tiny preloads. Every
IPC handler rejects senders whose frame is not a local file.

DevTools are enabled only for unpackaged builds or with
`WSL_WEB_SHELL_DEVTOOLS=1`; packaged production builds keep the debugger closed.

### Diagnostics hygiene

Backend output, exception text and startup URLs are untrusted strings. Every
published status (`message`, `detail`), tray/dialog text and log line passes
through `sanitizeForDisplay()`: ANSI escapes and control characters are removed,
whitespace is normalised, launch tokens are redacted and length is capped. The
log redacts as well, so a token can never reach a screenshot, the clipboard or a
shared diagnostic bundle.

Linear bar semantics: `footer:status` and `footer:versions` are read-only
snapshots published to the bar, `footer:toggle-settings` accepts only a validated
anchor rect (four finite numbers), `footer:open-release` can open only the URL the
version lookup returned, and the popover reuses `settings:load`/`settings:save`.
The version lookup itself lives outside the renderer
(`src/main/backend/github-versions.ts`): one hard-coded GitHub API origin, no
credentials, 8 s timeout, 512 KiB response cap, `redirect: 'error'`, results
cached in `userData/versions-cache.json` for 18 h, failures fail soft. Installed
version is read from `dsh --version` inside the distro once per successful start.

## Configuration

`userData/config.json` (validated on load and on save), `userData/owned-server.json`
(ownership record), `userData/versions-cache.json` (upstream release snapshot),
`userData/logs/app.log` (redacted, rotated at 2 MB). The app
never writes into the Linux home, the Windows DeepSeek Harness installation,
`app.asar`, user projects or any global runtime.

Backend-affecting settings (distro, port, workspace, executable path) are
snapshotted when a server is brought up, so editing them never silently restarts
or re-points a running backend; the tray "Restart WebUI" applies them.

## Diagnostics

Two failure modes are invisible from the UI and were left unexplained by the
first real run: a window that disappears on its own, and an Electron process that
ends without an error. Both are now recorded as causes, never as content
(`src/main/core/diagnostics.ts`, wired in `index.ts` and `windows.ts`):

- **Window events** — one `window <surface> <event> (...)` line for
  `shown`/`hidden`/`close-requested`/`closed` on the main window and on the splash
  overlay, with `visible`, `focused`, `quitting` and `session-ending` flags. A
  `close-requested` with `quitting=no` and `session-ending=no` means the close came
  from outside the app (X button, Alt+F4, taskbar menu, or a page-initiated
  `window.close()`); the app itself only ever exits through `quitting=yes`.
- **OS logoff/shutdown** — the Windows-only `session-end` window event sets the
  flag before the window is closed, so a shutdown-driven hide is not mistaken for
  a user click.
- **Previous run** — the tail of the log is read *before* the new run writes its
  first line. The orderly quit path writes the `shutdown complete` marker, so a
  missing marker on start-up means the previous process was killed externally or
  died from a native fault; the last recorded event is quoted (sanitised, capped).
- **Fatal faults** — `uncaughtException` and `unhandledRejection` are logged
  (`name: message`, no stack) before the process is terminated; the outcome stays
  fatal, the cause no longer silent. `child-process-gone` records renderer/utility
  failures with type, reason and exit code.

The log stays content-free by construction: nothing here reads window text, page
markup, cookies, environment values or backend payloads, every string passes
`sanitizeForDisplay` (ANSI/control stripping, token redaction) and
`redactUserPaths` (`C:\Users\<user>`, `/home/<user>`, `/mnt/<drive>/Users/<user>`,
`/Users/<user>`). Diagnostics never change window behaviour, and their own
failures are swallowed.

## Testing

`npm test` (vitest) covers the Electron-free core: startup URL parsing and
redaction, argv construction and path validation, WSL output decoding,
ownership/PID-reuse decisions, port classification and a real loopback socket
probe, lifecycle transitions and backoff, navigation/popup/permission policy,
configuration validation, tray model, and supervisor flows against injected
fakes (ready, collision, foreign listener, cookie rejection, unexpected exit,
retry exhaustion, health recovery, shutdown).

Issue #9 added `tests/footer.test.ts` (bar model, geometry, anchor validation),
`tests/versions.test.ts` (CLI parsing, SemVer precedence, release selection, cache
policy, offline fail-soft) and `tests/r09.test.ts` (composition guards). The
workspace contract moved to `src/main/core/workspace.ts` so Settings and the
launcher cannot disagree about a trailing slash (issue #8).

Issue #12 now has `tests/manual-update.test.ts` (exact version guard, downgrade
refusal, manager-specific install line, root escalation, stop/install/start order,
every backend/scope branch, console availability), `tests/update-console.test.ts`
(script text, first-failure status, guaranteed start, result verdicts) and
`tests/console-update-runner.test.ts` (console argv, base64, no `detached`), plus
`tests/inspect.test.ts` and `tests/managed.test.ts`, which pin the read-only
inspection and cgroup probes. `tests/supervisor.test.ts` pins the pause: no recovery,
no health check, no keepalive re-arm while a console update owns the backend, and a
resume that brings the backend back. No test starts WSL or touches an installation.

Configuration gained two fields: `isolateEnvironment` (default on) and
`runtimeRoot`. Both require a backend restart, so the tray decision stays
explicit; a settings file written by an older build normalises to the isolated
defaults instead of silently running unisolated.

The launcher scripts are not only string-tested: `tests/isolation.test.ts` runs
them under `/bin/bash` with a throw-away `HOME` and a stub backend, proving that
the environment really reaches the child process, that preparation creates only
the planned directories, and that the single-argument helpers receive their
parameter (a `sh -c` operand lands in `$0`, not `$1`).

`npm run smoke:headless` additionally starts the real built main process under
Xvfb with a sanitised environment (Windows interop removed from `PATH`, throw-away
`HOME`) and asserts that launch reaches a terminal, actionable error instead of
crashing. It never touches a WSL distribution. It caught two launch-blocking
regressions that unit tests cannot see: Electron `session` and `Tray` being
created before `app.whenReady()`.

Covered by the real R02 acceptance (see `docs/evidence/r02.md`): real `wsl.exe`
behaviour, real `dsh web` output, Chromium cookie handling for the loopback
origin, the packaged runtime, window/tray rendering on Windows and the
refresh-after-restart path. Still uncovered: OS logoff/shutdown during a running
session, and any distro other than the owner's default Ubuntu.
