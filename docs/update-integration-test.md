# Integration test plan — one real update run

Status: **planned, not executed.** Nothing in this document has been run against a
real WSL installation. Execution needs explicit owner approval (see *Approval
gate*), and it must never use the owner's working instance, data or configuration.

## Goal

Prove end to end, once, on a real Windows host with a real Ubuntu WSL2
distribution, that the one-click update:

1. installs the exact published `@deepseek-ai/dsh` into the isolated runtime and
   reports the new version in the footer;
2. survives an `npm` failure without touching the running runtime;
3. restores and restarts the previous version when activation or the new backend
   fails (`rolled-back`), never claiming `done`;
4. relaunches the portable EXE and comes back with the *new* version running.

Everything else (the original WebUI, the 32 px bar, settings, tray, reconnect) is
already covered by the unit, chrome, composition and paint checks and is out of
scope here.

## Isolation — nothing of the owner is reused

| Thing | Owner's live value | Test value |
|---|---|---|
| Runtime root | `~/.local/share/wsl-web-shell` | `~/.local/share/wss-it-<stamp>` |
| App profile (`userData`) | `%APPDATA%\wsl-web-shell` | `%APPDATA%\wsl-web-shell-it-<stamp>` |
| Port | 3080 | 3091 |
| Workspace | owner's projects | `~/.local/share/wss-it-<stamp>/workspace` |
| EXE | installed/portable owner build | `F:\_tmp\acc\cap-<stamp>\WSL-Web-Shell-0.1.0-x64.exe` |
| Global DSH / official Windows Harness | untouched | untouched |

Rules for the whole run:

- Start only with `--user-data-dir=<test profile>` so config, logs, registry and
  `update-journal.json` land in the test profile.
- The test `config.json` sets `distro: Ubuntu`, `port: 3091`,
  `runtimeRoot: ~/.local/share/wss-it-<stamp>`, leaving an empty executable so the
  resolved isolated runtime is used.
- Port 3091 must be free before the run (`probePort`) and the app must fail closed
  if something else already listens there.
- Never run `wsl --shutdown`, never kill a process the app does not own, never
  touch `~/.dsh`, `~/.agents`, the global npm prefix or the official Windows
  Harness.
- Every step records `logs/app.log`, `update-journal.json` (present/absent) and a
  `desktopCapturer` screenshot of the bar.

## Preconditions

1. Owner approval for a real WSL run with the isolation above (below).
2. A free desktop with no fullscreen application and no focus-stealing window.
3. The candidate EXE downloaded from the successful Windows CI artifact of the
   branch under test, with its SHA-256 recorded before the run.
4. The isolated runtime seeded **once** by hand into
   `~/.local/share/wss-it-<stamp>/runtime` by an explicit, approved install of a
   *older* published version (for example the version currently in the owner's
   runtime) so an update is actually available. This is the only real install the
   test needs and it is approved separately from the update itself.
5. `npm view @deepseek-ai/dsh dist-tags` recorded, so the expected target version
   is known before the run.

## Scenario 1 — success and relaunch

1. Start the EXE with `--user-data-dir=<test profile>`; wait for the bar to show
   `● Connected` and `DSH <old version>`.
2. Confirm the update pill appears next to the circular-arrow icon and shows the
   published version from `npm view`.
3. Click it, read the confirmation window (target version, isolated runtime path,
   published-version check), confirm.
4. In the terminal window verify the phase order: `checking → installing (stage) →
   verifying → stopping → activating → starting → done`, the private
   `<root>/cache/npm` being used, and the version markers in the log.
5. Expect the app to relaunch the portable EXE automatically; after it comes back,
   the bar must read `DSH <new version>` and the WebUI must render normally.
6. On disk: `<root>/runtime` holds the new version, exactly one `previous-*`
   directory exists, `update-journal.json` is **absent**, and the old backend PID is
   gone while the new one is owned by the new app process.

Expected evidence: log excerpt, journal absence, `previous-*` listing, bar
screenshot, new/old PIDs, and `dsh --version` of the isolated runtime.

## Scenario 2 — install failure (no runtime touched)

1. Start the app on the test profile with the update available.
2. Break the download only, without touching anything outside the test root: point
   the isolated runtime's npm cache at a read-only directory or set the test
   profile's npm registry mirror to an unreachable host **inside the update
   script's environment** (a temporary test-only wrapper, approved in the
   precondition step — never a change to the owner's npm configuration).
3. Confirm: the terminal shows the npm failure, the phase is `failed`, the detail
   names the cause, the backend keeps serving the *old* version, and the bar still
   reports the old version.
4. On disk: `runtime` unchanged, `update/stage-*` removed or inert, journal absent,
   no `previous-*` added.

## Scenario 3 — rollback after a broken activation

1. Start the app on the test profile with the update available.
2. Replace only the *published target* with something that installs but cannot
   start: point the update at a test-only package version inside the test root
   (for example by pre-seeding a local cached tarball with a broken `bin`) so
   `verifying`/`starting` fails after the swap.
3. Confirm: `rolled-back` is reported, the terminal says the previous installation
   was restored and is running again, the bar returns to the old version, the
   WebUI renders, and the app does not relaunch into a broken state.
4. On disk: `runtime` is the old version again, the journal is absent, and only one
   `previous-*` remains.

## Scenario 4 — interrupted update (crash safety)

1. Start the update and kill the app (Task Manager) during `activating`.
2. Start the app again on the same test profile: recovery must finalize or roll
   back, never start on a half-swapped runtime, and must report the outcome in the
   log.
3. Corrupt `update-journal.json` by hand and start again: the app must open in a
   terminal blocked state naming the file, must **not** start DeepSeek Harness,
   and must keep the file.

## Pass criteria

- Scenario 1: `done`, new version in the bar, relaunch observed, journal absent.
- Scenarios 2 and 3: old version still serving, `failed` / `rolled-back`, journal
  absent, no `done`.
- Scenario 4: no start on an unknown runtime; blocked state with a clear message
  for the corrupt journal.
- In every scenario: the owner's runtime, profile, global DSH, official Windows
  Harness and user projects are byte-identical before and after (`git status` in
  the owner's workspace, `ls -l` of the official install, unchanged `~/.dsh`).

## Approval gate

Execution requires an explicit owner message approving, at minimum: (a) starting
the portable EXE on the real desktop with a test `userData`, (b) one real
`npm install` of `@deepseek-ai/dsh` into the isolated test runtime, (c) the
temporary test-only registry wrapper used in scenario 2, and (d) creating and
later deleting `~/.local/share/wss-it-<stamp>`. Without that approval this
document stays a plan; source-level green checks are not an acceptance pass.

## Cleanup

Stop the app with its own **Quit** (owned backend only), delete the test profile
and `~/.local/share/wss-it-<stamp>`, and confirm that no process, port 3091
listener or WSL-side file from the test remains.
