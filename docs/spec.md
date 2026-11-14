# DSH WSL — Product & Architecture Contract

Version: 0.1 / M1. Source of truth: [Issue #1](https://github.com/triagmas/dsh-wsl/issues/1). Status: M1 implementation complete; real Windows/WSL acceptance is still pending (see [evidence/r02.md](evidence/r02.md)).

## Purpose

Provide a standalone Windows Electron app, a single native window hosting a backend's **original WebUI** served from a **native existing WSL2 distribution**. DeepSeek Harness via `dsh web` is the first preset. Other local Linux WebUIs may be added as independently reviewed presets; do not attempt to be a browser or implement a second chat interface.

### Topology

```text
Windows taskbar / system tray
 └─ DSH WSL.exe (Electron main process)
    ├─ supervisor: startup, liveness, retry, process ownership
    ├─ tiny local splash: progress, connection/reconnect, actionable error
    └─ sandboxed Chromium BrowserWindow (original unmodified DSH WebUI)
         ↕ verified origin http://127.0.0.1:3080
      native Ubuntu WSL2 / dsh web --host 127.0.0.1 --port 3080 --no-open
         ↳ Linux session state, agents, models, terminal, tools, projects
```

The official Windows DeepSeek Harness Desktop is **not used or modified**. The app must not replace any upstream buttons, hotkeys or composer.

## Defaults and settings

| Setting | Default | Constraints |
| --- | --- | --- |
| Backend preset | DeepSeek Harness | future backends require tested transport and auth adapters |
| WSL distro | Ubuntu | use existing installed distro; do not create/install one |
| Bind host | 127.0.0.1 | immutable loopback-only |
| Local port | 3080 | configurable numeric port after validation; never arbitrary URLs |
| Window Close (X) | Hide to tray | server remains supervised |
| Tray Quit | Graceful complete exit | leaves the app-owned backend and its launcher running; never tears down WSL; next start adopts it |
| Health checks | visible ~10s, hidden ~25s | main-process timer; timings adjustable after measurements |
| Retry policy | bounded exponential backoff | stop with actionable error; avoid duplicate instances |
| Appearance | dark/light by OS | original UI decides its own theme |
| Startup visual | minimal orbital loader | original CSS animation, respects reduced motion |

Settings UI stays separate from the WebUI (tray menu / small app-owned settings panel). User cannot edit navigated URL. Backend profile settings are **not** an arbitrary shell-command textbox shipped enabled by default.

## Lifecycle state machine

`CHECKING → STARTING_WSL → STARTING_WEB → CONNECTING → READY`.

Additional states: `HIDDEN_IN_TRAY` (window hidden, still supervised), `RECOVERING` (when backend is interrupted), `ERROR` (terminal until retry), `QUITTING`. Transitions must be explicit, serialized and idempotent; there must not be multiple concurrent dsh-web starts.

- On application launch, take Electron single-instance lock, read app config, verify distro and prerequisites. If WSL is stopped, start it via `wsl.exe -d Ubuntu --exec ...`.
- If app-owned server is alive, reuse it; otherwise start a new owned Linux server. If fixed port is occupied by an unknown server, fail closed with a clear collision message, **do not silently connect** based on a page title or endpoint content. Exception: a listener whose own PID inside the distribution runs exactly our `dsh web --host 127.0.0.1 --port <port>` command line **and** whose stored session cookie authenticates is an externally managed backend (for example a systemd unit started at boot). The app attaches to it for the WebUI, reports `ownedServer:false` / `externalBackend:true`, and never stops, restarts or updates it; the PID comes from `/proc` inside the distribution, never from the port answer.
- A cold start with a free port first gives an external launcher a short head start (5 s, measured on the clock, attach attempts included) and attaches when a verified listener appears, so the app and a boot-time unit cannot race for the port on the very first launch; when nothing appears it starts its own backend as usual. A listener that is verified but not ready yet keeps the window open, and a listener that disappears during the wait frees the port for an app-owned backend.
- A successful attach is remembered in the app profile (`external-backend.json`). From then on the fixed port is treated as belonging to that launcher: a launch (or recovery after a lost connection) waits a bounded time for the listener and attaches as soon as the two checks pass, so a boot race cannot steal the port from the owner's unit and leave it in a restart loop. The backend is never taken over: it stays outside the app lifecycle and is never signalled.
- While that expectation holds, an app-owned backend serves on the first free port beside the fixed one (3080 -> 3081..3088, bounded) instead of taking the launcher's port. The launcher must always find its own port free; a competitor there is exactly what puts its unit into a permanent `EADDRINUSE` restart loop. When no port beside the fixed one is free, the app takes the fixed port rather than leaving the owner without a WebUI. The adopted fallback port is recorded in the ownership proof, so a later start adopts the running backend instead of orphaning it, and the fallback backend is stopped as soon as the launcher answers on its own port (one health tick), after which the app attaches to it.
- The expectation survives misses: after three consecutive starts without the launcher the app stops spending the wait on every start but keeps the port reserved and serves beside it. Only an explicit "take the port" action (Restart while nothing is attached) drops it. The expectation is also dropped when the settings name another port or distribution, and it is never a proof: every attach re-verifies PID, command line and session.
- While attached the app holds one lightweight `wsl.exe` session (`sleep`) because WSL2 powers a distribution off about ten seconds after its last client exits, which kills the owner's backend. That session is deliberately left behind on Quit: quitting the app must never take the distribution, and the backend inside it, down. It is spawned **without** `detached`: on Windows that flag maps to `DETACHED_PROCESS`, which defeats `CREATE_NO_WINDOW` and makes the console program allocate its own console — the default terminal application then opens a visible window. Closing that window killed the only client holding the distribution open on 2026-11-14, and the backend and WebUI session went down with the distro. Each healthy tick also checks that the session is still alive and re-arms it, so a session that dies is repaired before WSL2 powers the distribution off. An installed app-owned backend needs no such session, since its own launcher is the client.
- Read `dsh web` startup output: it may print a one-time **token-bearing local URL** for browser login. For installed upstream version, verify exact line/output format before coding. Parse only the expected `http://127.0.0.1:<configured port>` and permitted token path/query. Keep token ephemeral; send only to the isolated Electron browser partition, not logs, errors or crash uploads. Do not assume a fresh `localhost` session is already authorized. Redirect back to same origin is allowed.
- Load the original WebUI, without injecting replacement buttons or styles. Only show local splash prior to readiness and while reconnecting, never fake backend ready state.
- Clicking X hides to tray (never kills WSL/DSH), the background main process continues health checks. Tray click/Open re-shows, performs immediate health check, shows the recovering overlay until backend is ready, and restores the original WebUI.
- Unexpected exit or failed health => attempt controlled restart **of app-owned process** with capped retries and cooldown. An attached external backend is never restarted by the app: after a failed health check the app waits, bounded, for its own launcher to bring it back, re-attaches by itself when it does, and otherwise starts an app-owned backend so the WebUI is still served. Nothing the app did not start is ever signalled.
- Tray menu: Open, Connection Status, Restart WebUI, Settings, Quit. Restart is allowed only for owned process. Quit ends Electron but **leaves the app-owned backend running**: its lifetime follows the WSL distribution, not the app window, and the next start verifies the recorded PID/start time and adopts the same process. Only an explicit Restart WebUI or a settings change that requires a restart may stop it, and only through the ownership-checked path; the distro itself is never torn down by the app. Persist only app config/browser session under a dedicated app profile.
- Missing WSL, distro, Node or DSH: show steps to install; never fetch binaries or install a private copy silently. DSH WSL runs the `dsh` the distribution already has (issue #17); it never updates that installation itself.
- A newer published release only produces instructions. The app performs a read-only inspection (executable, manager, prefix, versions, processes) and a read-only cgroup lookup for the unit of an attached backend, then shows the exact commands the owner runs in a WSL terminal: `sudo systemctl stop <unit>` / install / `sudo systemctl start <unit>` for a system unit, the same without `sudo` and with `--user` for a user unit, or the install line alone with a "stop it yourself" note for a hand-started or app-owned backend. `npm install -g` and `pnpm add -g` are the only install forms. An unknown manager, version or target produces no command at all, and a unit name is only used when it was discovered from the backend's own cgroup and passed the service-name guard.
- The owner may instead press **Run in WSL console**: the app runs *the same command list* as one script in a visible `wsl.exe` window, so `sudo` prompts there and the output stays on screen. The script echoes every command, tees to `~/.local/share/wsl-web-shell/update-<UTC>.log`, stops at the first failure, always runs the `start` line after a `stop`, keeps the first failing status as its exit code and waits for Enter before closing. The app never reads, stores or forwards a password: the console TTY owns the prompt, and the script arrives base64-encoded as `bash -c` text, which keeps stdin a TTY.
- While that console runs, the supervisor is paused (`suspendForUpdate`): it stops its own backend through the ownership-checked path and suppresses recovery, health checks, hand-back and the keepalive re-arm. Otherwise it would read the unit stop as a lost backend and start its own from the files npm is replacing. `resumeAfterUpdate` runs on every outcome, including a console closed early, and re-attaches or restarts. Only an app-owned backend, no backend, or an attached backend with a discovered **system** unit offers the button; a hand-started backend or a user unit stays copy-only.
- Otherwise the app never runs `sudo` or `systemctl`, never writes the installation and never stops or starts the backend for an update. The install line is escalated only for an unwritable prefix (`sudo env "PATH=$PATH" …`), and it is the same line shown in the window. **Check again** repeats the read-only inspection; no cache may answer it.
- The app takes no recovery snapshot, writes no journal and performs no automatic rollback: the only way back is the install line for the previous version that the window offers after a failed run.

## Security boundaries

- Electron `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true`, `webSecurity:true`; no preload granting Node/FS/process APIs to backend WebUI, and no disabling security flags to work around WebUI bugs.
- Exact origin allowlist for navigation; deny popup/window.open by default. Support external HTTPS links through system browser only after deliberate policy checks, **not** arbitrary `shell.openExternal` from backend content: only https links that are neither loopback, LAN nor a literal IP qualify, the app window must be focused, and repeated hand-offs are rate-limited because Electron exposes no user-gesture flag.
- Verify backend ownership independently from port reachability; a listener is attached (never owned) only after the two checks above pass, and the app never signals it. Local port bind must not expose WebUI to LAN/Internet. Tokenized startup URLs are credentials: no logging, screenshots, clipboard or diagnostic uploads containing secrets. The recorded ownership proof is discarded only when it is proven wrong (command line/PID mismatch), when the recorded process has been stopped or is confirmed gone, or when it names a different port or distro; an inconclusive probe keeps it, so a live backend can still be adopted by the next start.
- Use `spawn` with fixed argument arrays, validate distro/port/profile args. If invoking a shell inside WSL for compatibility, use fixed scripts and safe argument handling; no interpolation of untrusted user text.
- Track owned process IDs and lifecycle, handle WSL spawning process trees safely. No `wsl --shutdown`, mass `Stop-Process`, `taskkill`, or killing unrelated service on port.
- Do **not** change official Windows DSH the installed official Windows Harness application directory, the owner's existing Windows Harness data/profile directory, Windows Desktop profile/plugin configs, global networking settings or user projects.
- Do not automatically download runtime dependencies at first launch. Respect Electron code-signing/installer trust considerations for future release. The software will be public; do not commit token samples, private addresses or identifiable log paths.

## UI / visual direction

Use a minimal **original** local splash inspired by [21st.dev's Orbital Loader](https://21st.dev/@molecule-lab-rushil/components/orbital-loader), not a wholesale dependency-heavy UI kit. A soft animated orbit, neutral dark background, logo + short stage-specific messages. Allow an optional light look and `prefers-reduced-motion`; no fabricated percentage or imitation of Harness's composer. On reconnect, a slight backdrop dim/blur with “Reconnecting…” is enough. Show Retry/Diagnostics when terminally failed. The actual DSH WebUI remains intact.

The main window keeps a thin permanent bottom bar (30–34 px) owned by the app: connection state, distro and port on the left, the running `DSH` version and the latest published GitHub release on the right, and a gear that opens a compact settings popover. It is chrome around the WebUI, not a redesign of it: the remote page lives in its own `WebContentsView` above the bar with no injected markup, styles or scripts, and the version lookup is informational only — the pill opens the manual instructions in [update.md](update.md), and the app changes nothing. Contract and limits: [footer.md](footer.md).

## Testing and deliverables

**R00**: independent Electron/TypeScript scaffold in branch `feat/m1-electron-shell` from clean public repo main; README, lint, TS build, unit tests, Windows GitHub Actions. Validate current DSH Web CLI startup/authorization semantics from primary source and/or local inspection; document uncertainties. No real user-environment execution.

**R01**: app main, WSL supervisor, dynamic authenticated URL bootstrap, strict local navigation, tray, health/retry, splash. Tests: origin/token validation, port conflicts, WSL spawning argument integrity, process ownership, concurrent launch prevention, X→tray vs Quit and recovery. Package Windows x64 EXE; record actual path, SHA-256, tests and added/deleted line counts.

**R02**: **separate explicit owner consent** before any real launch in Ubuntu or modifying existing environment. Test start when WSL stopped, fresh browser auth, real composer, Linux tool execution in dummy project, X→tray persistence, server loss/recovery, tray Quit and no changes to working Windows Desktop/profile. Never test by killing unrelated services.

## Governance

The source repo is `triagmas/dsh-wsl` (public, MIT), a fresh product, **not a migration of old plugin code**. Previous plugin repository `triagmas/dsh-wsl-native` stays intact as history. GitHub = source of truth. Do not merge PR or publish release without owner approval. All code/docs in English; user-facing Pi reports in Russian, with HEAD, changed file and +/− lines, tests and explicit blocked/not-run items.
