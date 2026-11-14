# DeepSeek Harness update: run it in a WSL console (issues #12, #17, beta.13)

DSH WSL does not update the installation itself. When a newer release is published,
the footer pill opens a window that states the installed and the published version and
shows the exact commands. There are two ways to run them:

- **Run in WSL console** — one primary button runs *the same list* as one script in a
  visible `wsl.exe` window, so `sudo` asks for the password there and the output stays
  on screen. The app waits for the window to close, then re-reads the installation and
  says what changed.
- **copy and run it yourself** in a WSL terminal — always available, unchanged.

The window still asks for no password and has no password field: the console window
owns the prompt. DSH WSL never reads, stores or forwards a password, and it never
spawns `sudo` or `systemctl` itself — the script runs in the distribution, in a
window the owner can watch and close.

## What the button runs

The script is built by the pure `buildUpdateScript()` in
`src/main/core/update-console.ts` from the plan's command list, so the window shows
exactly what will run. It refuses to build when a line contains a quote or a newline,
or when the log path is not absolute — neither can come from the plan, so their
presence means something else was built.

The script:

1. creates `~/.local/share/wsl-web-shell/update-<UTC>.log` and tees everything to it;
2. echoes each command before running it (`$ sudo systemctl stop …`), so the window is
   readable after the fact without the log;
3. runs the commands in order and stops at the first failure;
4. when the list is `stop … install … start`, runs the **start line on every path**
   after the stop was attempted — a failed install must never leave the owner without
   a service;
5. exits with the first failing status, prints the exit code and the log path, then
   waits for **Enter** so the window stays open long enough to read.

`eval "$(echo '<base64>' | base64 -d)"` carries the script into `bash -c`: base64
survives `wsl.exe` argument quoting, and the command substitution keeps stdin on the
console TTY. Piping into `bash` would replace stdin with a pipe and break both the
`sudo` prompt and the closing prompt.

The window is a real console because the script has to be interruptible and the
password prompt has to work. `windowsHide` is `false` on purpose and `detached` stays
off (beta.12: `detached` maps to `DETACHED_PROCESS` and breaks console behaviour).

## The app pauses while the console runs

While the console owns the backend, `Supervisor.suspendForUpdate()` sets a pause flag:

- the app stops the backend it started itself, through the existing ownership-proven
  `stopOwnedServer()` path — the console never kills a pid it did not start, and the
  plan no longer contains `kill <pid>; sleep 2`;
- recovery, health checks, hand-back and the distribution keepalive re-arm all stay
  quiet. Left running, the supervisor would read the unit stop as a lost backend and
  start its own from the files npm is replacing (the beta.6 `EADDRINUSE` bug).

`resumeAfterUpdate()` runs on every outcome, including a console the owner closed
early: it clears the flag and goes through the ordinary bring-up path, which
re-attaches to the restarted unit or starts an app-owned backend again. A failure
there is logged, not escalated — the owner already sees the console result.

Only where the app can stop and start the backend itself does the button appear: an
**app-owned** backend, **no backend**, or an attached backend with a discovered
**system** unit. A hand-started backend and a **user** unit stay copy-only, because
the app cannot stop them safely.

## What the window shows

| Fact | Source |
| --- | --- |
| Installed version | `dsh --version` of the executable the launcher uses |
| Available version | informational GitHub releases lookup (18 h cache) |
| Distribution | the selected WSL distribution |
| Executable | the resolved `dsh` path |
| Install scope | npm/pnpm global prefix and whether it is user or system-wide |

When the installed version is already the published one, the window says so and
shows no command. A **downgrade is never offered**: when the published version is
older than what is installed (prerelease, local build, channel change) the window
says the installation is already newer.

**Check again** runs a fresh read-only inspection. After a console run the window
re-reads the installation and reports the console exit code, the installed version,
the log path and, when the version did not move, the one line that installs the
previous version again. Success is decided by the version the app reads afterwards,
not by the exit code: a console the owner closed reports a signal, and npm can fail
after writing.

## The commands

The plan is built by the pure `buildManualUpdatePlan()` in
`src/main/core/manual-update.ts`. The browser process never executes it.

| Situation | Commands | Console button |
| --- | --- | --- |
| the owner's systemd **system** unit runs the attached backend | `sudo systemctl stop <unit>`, `<manager> install -g @deepseek-ai/dsh@<version>`, `sudo systemctl start <unit>` | yes |
| a **user** unit runs it | `systemctl --user stop <unit>`, install, `systemctl --user start <unit>` | no, copy-only |
| the attached backend was started by hand | install only, plus "stop the backend by hand before running this command" | no |
| the backend belongs to DSH WSL | install only — the app stops its own backend before the console runs | yes |
| no backend is running | install only | yes |
| the manager is pnpm | `pnpm add -g @deepseek-ai/dsh@<version>` | as above |
| the manager, installed version or target is unknown | no command, only an explanation | no |
| the published version could not be checked | no command: the cached target is not presented as current | no |

`npm install -g` is bound to the inspected installation (`"<npmPath>" install -g --prefix "<prefix>"`)
whenever both are known and safe to quote, because a bare command installs into
whatever prefix the owner's own terminal resolves. When the prefix is not writable by
the owner, the install line itself is escalated (`sudo env "PATH=$PATH" "<npm>" …`)
and the description says so — that is part of every pending branch, not only the
system-unit one.

`npm install -g` and `pnpm add -g` are the only install forms. The target must be an
exact version: ranges, tags and anything a shell could interpret are refused. A unit
name is shown only when it is a valid `.service` name discovered read-only from
`/proc/<pid>/cgroup`; the app never invents one.

The installed version means what the inspected executable reports, not a cached
status field. A version that cannot be read is reported as unknown, and no command
is shown.

## What is still read from the distribution

The inspection script in `src/main/wsl/inspect.ts` is launched as
`wsl.exe -d <distro> --exec /bin/sh -c <script> <args…>` with validated positional
operands. It only reads:

1. the executable a login shell resolves, the minimal `--exec` path, or the
   configured path;
2. `readlink -f`, the package directory and `package.json` identity;
3. `npm prefix -g` / `pnpm root -g` and whether the prefix is writable;
4. `/proc` for other processes running from the same real path;
5. the versions reported by the app executable and by the login-shell executable.

The systemd unit is discovered separately, also read-only, from the attached
backend's cgroup. Failure to identify a unit is not an error: the window then shows
the install line and asks the owner to stop the backend by hand.

## Windows and IPC

| Surface | File | Notes |
| --- | --- | --- |
| update window | `src/update/confirm.html` | 640×620, modal, non-resizable, `sandbox: true`, CSP `default-src 'none'` |
| bridge | `src/preload/update.ts` | `probe`, `recheck`, `run`, `close` |
| console runner | `src/main/wsl/console.ts` | `wsl.exe -d <distro> --exec /bin/bash -c …`, `windowsHide: false`, no `detached` |
| script and result | `src/main/core/update-console.ts` | pure: script text, log path, result verdict |

Channels: `footer:open-update`, `update:probe`, `update:recheck`, `update:run`,
`update:close`. All go through the existing trusted-sender guard, and only one console
run can be in flight at a time. The page performs no network I/O and has no password
field.

Per-line **Copy**, **Copy all** and the rollback line use the clipboard API with a
selection-based fallback; each copied line is announced through an `aria-live` region.

## Out of scope (deliberately)

The beta.11 in-app updater was removed and does not come back this way: no verified
snapshot, no journal, no automatic rollback, no sudo helper, no password dialog, no
`systemctl` call from the app, no user-unit management. The console runs a short
script the owner can read in the window; going back is one copied install line.

## Verification

- `tests/update-console.test.ts` — script text (log, tee, echo, first-failure status,
  start-after-stop), refusal of quote/newline log paths, result verdicts (success,
  unchanged, console never started, version unreadable), plan gate.
- `tests/console-update-runner.test.ts` — console argv, base64 encoding, no
  `detached`, `windowsHide: false`, exit/error handling.
- `tests/manual-update.test.ts` — exact-version guard, downgrade refusal,
  manager-specific install line, root escalation for an unwritable prefix,
  stop/install/start order, console availability per backend and scope.
- `tests/supervisor.test.ts` — pause suppresses recovery, health checks and the
  keepalive re-arm; resume brings the backend back.
- `tests/inspect.test.ts`, `tests/managed.test.ts`, `tests/dsh-locate.test.ts`,
  `tests/r09.test.ts` — read-only inspection, unit discovery, provenance.

A real update of the owner's WSL installation is still an owner step: these tests
cover the script, the decisions and the window. The Windows console itself is only
exercised on a real desktop, never in CI.
