# One-click update (issue #12)

The footer bar can install the exact published `@deepseek-ai/dsh` version into the
isolated runtime the app is already using. Everything happens inside the current
WSL distribution, below the app's own runtime root; the global installation, the
official Windows DeepSeek Harness and the user's projects are never touched.

```
footer pill (only while an update exists)
   -> confirmation window  (facts + Update/Cancel)
   -> terminal window      (streamed output; Close only when the run finished)
   -> backend stopped, runtime swapped, new version started and auth-checked
   -> app relaunches the portable EXE (or says it cannot)
```

## When the offer appears

`VersionSnapshot.updateAvailable` (already produced by the informational GitHub
lookup, 18 h cache) decides it. The pill with the circular arrow is `hidden`
whenever `updateAvailable` is false, so the bar never shows an action for a
version that does not exist. The bar stays 32 px tall and unchanged otherwise.

## Guards (`src/main/core/update.ts`)

`planUpdate()` is pure and rejects, before anything runs:

| Reason | Condition |
| --- | --- |
| `invalid-version` | target is not an exact release (`^0.2.2`, `latest`, `…; rm -rf /`) |
| `not-newer` | `compareSemver(target, installed) <= 0` |
| `installed-unknown` | `dsh --version` did not report a parsable version |
| `global-installation` | `isolateEnvironment` is off — the app would replace a global DSH |
| `custom-executable` | a custom `dshPath` is pinned in Settings |
| `unsafe-root` | the configured root is not a dedicated subtree, or WSL reported no canonical root |
| `foreign-runtime` | the executable in use is not **exactly** `<canonical root>/runtime/bin/dsh` |

Ownership is an exact comparison against the root WSL itself reported
(`RESOLVE_RUNTIME_SCRIPT` prints `root=…` after `cd … && pwd -P`), so a configured
`~/…` root is never matched as a substring: another user's home, a
similarly-named directory, a nested copy or `runtime/bin/dsh.tmp` are all
rejected. Versions are compared with `isSameVersion()` (SemVer equality), never
with `startsWith`/`includes`.

## The updater scripts (`src/main/wsl/update-args.ts`)

Every step runs through `wsl.exe -d <distro> --exec /bin/sh -c <script> <args…>`
with validated operands (version, root, transaction id, binaries) — no
interpolated command strings. All five scripts share one prologue:

- a configured `~/…` root is expanded against `$HOME` **inside the script** (a
  quoted tilde passed as a positional argument is not expanded by the shell) and
  then canonicalised with `pwd -P`;
- path traversal, `//`, `/.`, unexpected characters and anything less than a
  dedicated subtree are rejected;
- the root and the `runtime`, `update`, `cache` components must not be symlinks,
  so nothing is written through a link that points outside the root;
- npm always uses the **private cache** `<root>/cache/npm` (`--cache` plus
  `npm_config_cache`), never `~/.npm`.

| Step | Script | What it does |
| --- | --- | --- |
| npm lookup | `NPM_VIEW_SCRIPT` | read-only `npm view @deepseek-ai/dsh@<ver> version`; an unpublished version stops the run |
| stage | `STAGE_SCRIPT` | `npm install --global --prefix <root>/update/stage-<tx> --cache <root>/cache/npm`, then the staged `dsh --version` must equal the target **exactly** (`exit 71` otherwise). The running runtime is untouched |
| activate | `ACTIVATE_SCRIPT` | re-verifies the stage, `runtime` → `update/previous-<tx>`, stage → `runtime`, re-verifies the activated executable; on mismatch it restores the previous tree (`exit 72`/`73`/`74`) and keeps exactly one `previous-*` |
| restore | `RESTORE_SCRIPT` | idempotent rollback used by the failure path and by journal recovery (`runtime` missing + `previous` present, or a wrong active version) |
| inspect | `INSPECT_SCRIPT` | read-only report: `runtime=present|missing`, `version=…`, the newest `previous-*` and `stage-*` names |

## Transaction: quiesce, swap, verify, recover

The backend is **not** stopped before it has to be:

1. `checking` — the exact version exists on npm;
2. `installing` — staged next to the running runtime (the backend keeps serving);
3. `verifying` — the staged executable reports exactly the target version;
4. `stopping` — the update lock is set (auto-recovery, health checks, tray
   restart/retry and Quit are refused), then only the **app-owned** backend is
   stopped through the normal ownership-checked path;
5. `activating` — the swap, with the previous installation kept;
6. `starting` — a full backend start (distribution, runtime resolution, token
   exchange, authenticated request). Success is only reported after this, so a
   new version that cannot serve the WebUI is a failed update, not a green one.

A journal (`<userData>/update-journal.json`) records transaction id, phase, target
and canonical root. Writing it is **fail-loud**: the content is flushed with
`fsync`, renamed into place and read back, and a write that cannot be confirmed
stops the update before the backend is touched — a runtime that cannot be
repaired after a crash is never replaced. If the app, the process
or Windows dies between the two renames, the next start repairs it:

| Observed state | Action |
| --- | --- |
| runtime present and reporting the target | `finalize` — the update had finished; start normally |
| runtime present with another version, previous available | `rollback` — restore the previous installation |
| runtime missing, previous available | `rollback` |
| runtime missing, nothing but the stage | `rollback` (stage is activated) |
| runtime missing, nothing to restore | `blocked` — the app refuses to start a half-swapped tree and explains it |

Every failure path restores the previous installation, starts the old backend and
reports `rolled-back` ("previous version restored"), never `done`. The journal is
cleared **only** by that proven outcome (restore succeeded *and* the old backend
serves the WebUI again) or by a verified new version: a failed rollback, or a
restored runtime whose backend does not start, keeps the journal, puts the app
into a terminal blocked state and blocks further starts until a repair succeeds.
A stop that cannot be confirmed releases the update lock and is reported as an
explicit error, so the app never sits in a silent soft-lock.

Start-up reading has three outcomes: **no journal** — a normal start; **a valid
journal** — repair it; **a journal that exists but is corrupt or unreadable** —
the record is kept, DeepSeek Harness is not started and the app opens in a
terminal blocked state that names the file, because nothing can vouch for the
runtime after an unknown transaction. "Exists" is decided with `lstat`, so a
record behind a directory the app cannot traverse (`EACCES`/`EPERM`), a link whose
target is gone and any other entry that cannot be inspected all count as
unreadable, never as absent; only `ENOENT`/`ENOTDIR` mean there is no journal.

A planned real integration run (success, install failure, rollback, interrupted
update, relaunch) with its own runtime, app profile and port is described in
[update-integration-test.md](update-integration-test.md). It has not been executed
and requires explicit owner approval.

## Terminal window

The main process keeps a rolling buffer of 400 lines and publishes `dropped`
(how many lines fell off the front). The renderer rebuilds the buffer when that
number changes and appends otherwise, so the stream keeps moving past 400 lines
instead of freezing. Output is sanitized (`ANSI`/control characters stripped,
secrets redacted, 320 characters per line) and written with `textContent`.

While a run is active the window is not closable (`setClosable(false)` plus a
`close` guard) and tray Quit is refused, so a quit cannot interrupt the swap. A
finished or rolled-back run is closable.

## Relaunch

`resolveRelaunchTarget()` (pure) only accepts `PORTABLE_EXECUTABLE_FILE` when it
is an existing `.exe`, because a portable build runs from a temporary extraction
directory and relaunching `process.execPath` would start a copy that is deleted
right after exit. When no portable path is available the app **does not** claim
to restart itself: the terminal window explains that the update succeeded and
the app has to be started again.

The Windows CI job proves this on the packaged build:

```powershell
WSL-Web-Shell-0.1.0-x64.exe --relaunch-probe=<dir>
node scripts/check-relaunch.cjs <dir> <portable-exe>
```

The parent records its own paths, decides the target with the same function the
update uses and relaunches through `app.relaunch`; the child records the
executable it was started from.

A portable build always starts from a fresh extraction directory, so the child's
`process.execPath` is *not* the portable EXE — which is exactly why relaunching
`process.execPath` would be wrong. The portable launcher re-establishes the
origin, so the check asserts that the child still reports
`PORTABLE_EXECUTABLE_FILE` as the portable EXE (a child started from the inner
copy would report nothing) and that it is a new process.

## Windows and IPC

| Surface | File | Notes |
| --- | --- | --- |
| confirmation | `src/update/confirm.html` | 560×460, modal, `sandbox: true`, CSP `default-src 'none'` |
| terminal | `src/update/progress.html` | 720×520, resizable, `aria-live` pre |
| bridge | `src/preload/update.ts` | `probe/start/state/onState/close` only |

Channels: `footer:open-update`, `update:probe`, `update:start`, `update:state`,
`update:close` (main) and the `update:state` event. All are registered through the
existing `isTrustedSender` guard; the renderer performs no network I/O.

## Verification

- `tests/update.test.ts` — guards, exact version equality, ownership paths,
  terminal buffer and rolling-cap streaming, phase model, journal round-trip,
  every recovery decision, the full runner transaction (order, rollback on
  activation failure, rollback when the new version does not start, journal
  before the swap), portable relaunch decisions and the window/shutdown wiring.
- `tests/wsl-update-args.test.ts` — argument validation plus a real `/bin/sh`
  end-to-end run with a fake `$HOME` and a fake npm: `~/` expansion, private
  cache, symlinked root/runtime refusal, substring version refusal, staging,
  activation, rollback and recovery from an interruption at both swap boundaries.
- `tests/supervisor.test.ts` — quiesce stops only the owned backend and blocks
  recovery/restart/retry while locked, a failed resume is reported, and a blocked
  runtime becomes a terminal error.
- `npm run chrome:smoke` — renders the pill, the confirmation and the terminal
  window and asserts 38 behaviours, including streaming past 400 lines.
- Windows CI — packaged relaunch check (above) on a real runner.

All of this is isolated: no test starts WSL, npm, or a desktop session.
A real update on the owner's machine is a separate, explicitly approved step.
