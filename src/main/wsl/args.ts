/**
 * `wsl.exe` invocation builders.
 *
 * Every argument is a fixed literal or a validated value placed in its own
 * array slot: nothing is concatenated into a shell string. Linux-side script
 * text is a module constant; per-launch values arrive as positional parameters.
 */
import { LOOPBACK_HOST } from '../../shared/types.js';
import {
  ISOLATION_DISABLED,
  isValidIsolationRoot,
  isValidRuntimeBinary,
} from '../core/isolation.js';
import { normalizeWorkspacePath } from '../core/workspace.js';

export const WSL_EXE = 'wsl.exe';

/**
 * Prints the Linux PID that will own the web server, then replaces itself with
 * the server process (same PID), so the PID we record stays valid.
 *
 * `$0` = resolved dsh path, `$1` = host, `$2` = port, `$3` = isolation root
 * (or `-`), `$4` = resolved node binary (or `-`), `$5` = workspace.
 *
 * Everything path-related happens here, inside the distribution: `~` expands
 * against the Linux home and the working directory is entered by the shell, so
 * the launch does not depend on `wsl.exe --cd` understanding a tilde-prefixed
 * subpath. Every value is a validated positional argument, never interpolated
 * shell text.
 *
 * Exit codes: 64 malformed argument, 65 unusable workspace, 66 unsafe isolation
 * root, 67 symlinked or missing isolation directory.
 */
export const START_WRAPPER_SCRIPT = [
  'dsh="$0"; host="$1"; port="$2"; root="$3"; node="$4"; ws="$5"; iroot="";',
  'if [ "$root" != "-" ]; then',
  'case "$root" in "~"|"~/") echo "wsl-web-shell: isolation root must be a dedicated subtree" >&2; exit 66;;',
  '"~/"*) rz="${root#"~/"}"; rbase="$HOME";;',
  '/*) [ "$root" = "/" ] && { echo "wsl-web-shell: isolation root must not be the filesystem root" >&2; exit 66; }; rz="${root#/}"; rbase="";;',
  '*) echo "wsl-web-shell: rejected isolation root" >&2; exit 64;; esac;',
  'case "$rz" in *[!A-Za-z0-9._~/@+-]*) echo "wsl-web-shell: rejected isolation root" >&2; exit 64;; esac;',
  'case "/$rz/" in *"/../"*|*"/./"*|*"//"*) echo "wsl-web-shell: rejected isolation root" >&2; exit 66;; esac;',
  'case "$rz" in */*) ;; *) echo "wsl-web-shell: isolation root must be a dedicated subtree" >&2; exit 66;; esac;',
  'if [ -n "$rbase" ]; then iroot="$HOME/$rz"; else iroot="/$rz"; fi;',
  '[ -d "$iroot" ] && [ ! -L "$iroot" ] || { echo "wsl-web-shell: isolation root is missing or a symlink" >&2; exit 67; };',
  'for d in dsh-home agents cache tmp workspace; do [ -d "$iroot/$d" ] && [ ! -L "$iroot/$d" ] || { echo "wsl-web-shell: isolation directory is missing or a symlink" >&2; exit 67; }; done;',
  'fi;',
  'case "$ws" in "~") if [ -n "$iroot" ]; then ws="$iroot/workspace"; else ws="$HOME"; fi;; "~/"*) ws="$HOME/${ws#"~/"}";; /*) ;; *) echo "wsl-web-shell: rejected workspace" >&2; exit 64;; esac;',
  '[ -d "$ws" ] || { echo "wsl-web-shell: workspace directory not found" >&2; exit 65; };',
  'cd "$ws" || exit 65;',
  'if [ -n "$iroot" ]; then',
  'export DSH_HOME="$iroot/dsh-home";',
  'export DSH_AGENTS_HOME="$iroot/agents";',
  'export XDG_CACHE_HOME="$iroot/cache";',
  'export TMPDIR="$iroot/tmp";',
  'export WSL_WEB_SHELL_ISOLATION_ROOT="$iroot";',
  'if [ "$node" != "-" ]; then export PATH="$iroot/runtime/bin:$(dirname "$node"):$PATH"; else export PATH="$iroot/runtime/bin:$PATH"; fi;',
  'fi;',
  'printf "%s %s\\n" "__dsh_web_shell_pid__" "$$";',
  'exec "$dsh" web --host "$host" --port "$port" --no-open',
].join(' ');

export const PID_MARKER = '__dsh_web_shell_pid__';

/**
 * `sh -c SCRIPT arg0 arg1 ...` puts the first operand into `$0`, so every
 * script invoked without a meaningful `$0` receives this fixed label and reads
 * its real parameters from `$1`, `$2`, ...
 */
export const SCRIPT_ARGV0 = 'wsl-web-shell';

/**
 * Create the isolated environment (private runtime, DSH_HOME, agents home,
 * caches, temp, workspace) before the backend starts.
 *
 * Safety rules, all enforced before the first write:
 * - the root must be a dedicated subtree (`/`, `~`, `~/`, `~/x`, `/x` are
 *   rejected) with no `.`/`..`/empty segments;
 * - no component from the home (or filesystem root) down to the root may be a
 *   symlink, so `mkdir -p` can never be redirected outside the configured tree;
 * - every managed subdirectory is re-checked after creation for symlinks and
 *   canonical placement;
 * - only `mkdir -p` is used: pre-existing content is neither changed nor
 *   removed.
 *
 * Exit codes: 64 malformed argument, 66 unsafe root, 67 symlink or non-canonical
 * placement, 70 creation failed.
 */
export const PREPARE_ISOLATION_SCRIPT = [
  'root="$1";',
  'case "$root" in',
  '"~"|"~/") echo "wsl-web-shell: isolation root must be a dedicated subtree" >&2; exit 66;;',
  '"~/"*) rel="${root#"~/"}"; base="$HOME";;',
  '/*) if [ "$root" = "/" ]; then echo "wsl-web-shell: isolation root must not be the filesystem root" >&2; exit 66; fi; rel="${root#/}"; base="";;',
  '*) echo "wsl-web-shell: rejected isolation root" >&2; exit 64;; esac;',
  'case "$root" in *[!A-Za-z0-9._~/@+-]*) echo "wsl-web-shell: rejected isolation root" >&2; exit 64;; esac;',
  'case "/$rel/" in *"/../"*|*"/./"*|*"//"*) echo "wsl-web-shell: rejected isolation root" >&2; exit 66;; esac;',
  'case "$rel" in */*) ;; *) echo "wsl-web-shell: isolation root must be a dedicated subtree" >&2; exit 66;; esac;',
  'if [ -n "$base" ]; then home_real=$(cd "$HOME" && pwd -P) || exit 67; walked="$HOME"; expected="$home_real/$rel"; else walked=""; expected="/$rel"; fi;',
  'for seg in $(printf "%s" "$rel" | tr "/" " "); do walked="$walked/$seg"; if [ -L "$walked" ]; then echo "wsl-web-shell: symlink in isolation path" >&2; exit 67; fi; done;',
  'if [ -n "$base" ]; then [ "$expected" = "$home_real" ] && { echo "wsl-web-shell: isolation root must not be the home directory" >&2; exit 66; }; fi;',
  'umask 077;',
  'mkdir -p "$expected" || exit 70;',
  '[ ! -L "$expected" ] || { echo "wsl-web-shell: isolation root is a symlink" >&2; exit 67; };',
  'real=$(cd "$expected" && pwd -P) || exit 67;',
  '[ "$real" = "$expected" ] || { echo "wsl-web-shell: isolation root resolves outside its configured path" >&2; exit 67; };',
  'for d in runtime/bin dsh-home agents cache tmp workspace; do',
  'cur="$expected"; for seg in $(printf "%s" "$d" | tr "/" " "); do cur="$cur/$seg"; if [ -L "$cur" ]; then echo "wsl-web-shell: isolation directory is a symlink" >&2; exit 67; fi; done;',
  'mkdir -p "$expected/$d" || exit 70;',
  '[ ! -L "$expected/$d" ] || { echo "wsl-web-shell: isolation directory is a symlink" >&2; exit 67; };',
  '[ "$(cd "$expected/$d" && pwd -P)" = "$expected/$d" ] || { echo "wsl-web-shell: isolation directory resolves outside its configured path" >&2; exit 67; };',
  'done;',
  'printf "%s\\n" "$expected"',
].join(' ');

/**
 * Locate the backend executable and a node runtime inside the distribution.
 * `$1` = isolation root (`-` when disabled); the isolated runtime is preferred
 * over system installs. Diagnostics only: read-only filesystem tests.
 */
export const RESOLVE_RUNTIME_SCRIPT = [
  'iso="$1";',
  'case "$iso" in "~") iso="$HOME";; "~/"*) iso="$HOME/${iso#"~/"}";; /*) ;; *) iso="";; esac;',
  // Canonical root: `pwd -P` resolves a symlinked `$HOME`, so the updater can
  // compare the executable path exactly instead of guessing with substrings.
  'root="";',
  'if [ -n "$iso" ] && [ -d "$iso" ]; then root="$(cd "$iso" && pwd -P 2>/dev/null)" || root=""; fi;',
  'printf "root=%s\n" "$root";',
  'dsh="";',
  'if [ -n "$iso" ] && [ -x "$iso/runtime/bin/dsh" ]; then dsh="$iso/runtime/bin/dsh"; fi;',
  'if [ -z "$dsh" ]; then for c in "$HOME/.local/bin/dsh" /usr/local/bin/dsh /usr/bin/dsh "$HOME/.npm-global/bin/dsh"; do',
  'if [ -x "$c" ]; then dsh="$c"; break; fi; done; fi;',
  'if [ -z "$dsh" ]; then for c in "$HOME"/.nvm/versions/node/*/bin/dsh "$HOME"/.volta/bin/dsh; do',
  '[ -x "$c" ] && { dsh="$c"; break; }; done; fi;',
  'if [ -z "$dsh" ]; then p=$(command -v dsh 2>/dev/null) && [ -x "$p" ] && dsh="$p"; fi;',
  'if [ -z "$dsh" ]; then p=$(bash -lc "command -v dsh" 2>/dev/null | tail -n 1) && [ -x "$p" ] && dsh="$p"; fi;',
  'node="";',
  'for c in "$HOME/.local/bin/node" /usr/local/bin/node /usr/bin/node; do',
  'if [ -x "$c" ]; then node="$c"; break; fi; done;',
  'if [ -z "$node" ]; then p=$(command -v node 2>/dev/null) && [ -x "$p" ] && node="$p"; fi;',
  'printf "dsh=%s\\n" "$dsh";',
  'printf "node=%s\\n" "$node";',
  'exit 0',
].join(' ');

/**
 * Read start time and command line of a Linux PID. The start time guards
 * against PID reuse; the command line proves the process is our backend.
 */
export const PROBE_PROCESS_SCRIPT = [
  'pid="$1";',
  '[ -r "/proc/$pid/stat" ] || exit 10;',
  '[ -r "/proc/$pid/cmdline" ] || exit 11;',
  'read -r st < "/proc/$pid/stat" || exit 12;',
  'rest=${st##*) };',
  'set -- $rest;',
  '[ $# -ge 20 ] || exit 13;',
  'shift 19;',
  'printf "starttime=%s\\n" "$1";',
  'printf "cmdline="; tr "\\000" " " < "/proc/$pid/cmdline"; printf "\\n"',
].join(' ');

const DISTRO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class ArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgumentError';
  }
}

export function assertDistroName(distro: string): string {
  if (typeof distro !== 'string' || !DISTRO_PATTERN.test(distro)) {
    throw new ArgumentError('invalid-wsl-distro-name');
  }
  return distro;
}

export function assertPort(port: number): number {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new ArgumentError('invalid-port');
  }
  return port;
}

/**
 * Workspace validation (shared with Settings, issue #8).
 *
 * The shell expands `~` and enters the directory, so the value must be `~`,
 * `~/...` or absolute with no structural or empty segments. A trailing slash is
 * conventional and is normalised away instead of failing the launch.
 */
export function assertWorkspace(workspace: string): string {
  const normalized = normalizeWorkspacePath(workspace);
  if (normalized === null) throw new ArgumentError('invalid-workspace-path');
  return normalized;
}

export function assertDshPath(dshPath: string): string {
  if (typeof dshPath !== 'string' || !dshPath.startsWith('/') || dshPath.length > 4096) {
    throw new ArgumentError('invalid-dsh-path');
  }
  if (/[\0\r\n]/.test(dshPath) || dshPath.split('/').includes('..')) {
    throw new ArgumentError('invalid-dsh-path');
  }
  return dshPath;
}

export function assertLinuxPid(pid: number): number {
  if (!Number.isInteger(pid) || pid <= 1 || pid > 4_194_304) {
    throw new ArgumentError('invalid-linux-pid');
  }
  return pid;
}

/** `wsl.exe -l -q` — installed distribution names. */
export function buildListDistrosArgs(): string[] {
  return ['-l', '-q'];
}

/** Verify a user-supplied absolute executable path without running it. */
export function buildDshPathCheckArgs(distro: string, dshPath: string): string[] {
  return ['-d', assertDistroName(distro), '--exec', '/bin/test', '-x', assertDshPath(dshPath)];
}

/**
 * Version probe wrapper.
 *
 * `wsl.exe --exec` starts the executable directly with the distribution's
 * minimal PATH. An npm-installed `dsh` is a shell shim whose first line is
 * `#!/usr/bin/env node`, so the kernel needs `node` on PATH and fails with
 * `env: 'node': No such file or directory` (exit 127) when the runtime lives in
 * `~/.local/bin`. The launcher already resolves that Node.js binary for the
 * backend start, so the probe puts its directory in front of PATH the same way
 * the start wrapper does, instead of trusting an interactive profile.
 *
 * `$0` = executable, `$1` = resolved node binary (or `-`).
 */
export const VERSION_PROBE_SCRIPT = [
  'dsh="$0"; node="$1";',
  'if [ -n "$node" ] && [ "$node" != "-" ]; then export PATH="$(dirname "$node"):$PATH"; fi;',
  'exec "$dsh" --version',
].join(' ');

/**
 * Ask the selected executable for its version.
 *
 * `--version` is read-only and never touches a project, a session or the network.
 * Both paths are validated like every other launcher argument.
 */
export function buildDshVersionArgs(distro: string, dshPath: string, nodePath: string | null = null): string[] {
  const name = assertDistroName(distro);
  const dsh = assertDshPath(dshPath);
  if (nodePath === null) return ['-d', name, '--exec', dsh, '--version'];
  if (!isValidRuntimeBinary(nodePath)) throw new ArgumentError('invalid-runtime-binary');
  return ['-d', name, '--exec', '/bin/sh', '-c', VERSION_PROBE_SCRIPT, dsh, nodePath];
}

export interface StartServerOptions {
  distro: string;
  dshPath: string;
  port: number;
  workspace: string;
  host?: string;
  /** Isolated environment root (validated) and the resolved node binary. */
  isolationRoot: string;
  nodePath: string | null;
}

/**
 * Launch `dsh web` inside the distribution.
 * `--exec` avoids a shell for the outer command; the inner `bash` receives only
 * fixed script text plus validated positional values, so isolation variables are
 * exported by the distribution itself rather than forwarded from Windows.
 */
export function buildStartServerArgs(options: StartServerOptions): string[] {
  const host = options.host ?? LOOPBACK_HOST;
  if (host !== LOOPBACK_HOST) throw new ArgumentError('invalid-bind-host');
  if (options.isolationRoot !== ISOLATION_DISABLED && !isValidIsolationRoot(options.isolationRoot)) {
    throw new ArgumentError('invalid-isolation-root');
  }
  if (options.nodePath !== null && !isValidRuntimeBinary(options.nodePath)) {
    throw new ArgumentError('invalid-runtime-binary');
  }
  return [
    '-d',
    assertDistroName(options.distro),
    '--exec',
    '/bin/bash',
    '-c',
    START_WRAPPER_SCRIPT,
    assertDshPath(options.dshPath),
    host,
    String(assertPort(options.port)),
    options.isolationRoot,
    options.nodePath ?? ISOLATION_DISABLED,
    assertWorkspace(options.workspace),
  ];
}

/** Create the isolated environment directories before the backend starts. */
export function buildPrepareIsolationArgs(distro: string, root: string): string[] {
  if (!isValidIsolationRoot(root)) throw new ArgumentError('invalid-isolation-root');
  return ['-d', assertDistroName(distro), '--exec', '/bin/sh', '-c', PREPARE_ISOLATION_SCRIPT, SCRIPT_ARGV0, root];
}

/** Resolve `dsh` and `node` inside the distribution (read-only). */
export function buildResolveRuntimeArgs(distro: string, isolationRoot: string | null): string[] {
  const iso = isolationRoot === null ? ISOLATION_DISABLED : isolationRoot;
  if (iso !== ISOLATION_DISABLED && !isValidIsolationRoot(iso)) throw new ArgumentError('invalid-isolation-root');
  return ['-d', assertDistroName(distro), '--exec', '/bin/sh', '-c', RESOLVE_RUNTIME_SCRIPT, SCRIPT_ARGV0, iso];
}

export function buildProbeProcessArgs(distro: string, pid: number): string[] {
  return [
    '-d',
    assertDistroName(distro),
    '--exec',
    '/bin/sh',
    '-c',
    PROBE_PROCESS_SCRIPT,
    SCRIPT_ARGV0,
    String(assertLinuxPid(pid)),
  ];
}

/** POSIX signal delivery by number-free name to one verified PID. */
export function buildSignalArgs(distro: string, pid: number, signal: 'TERM' | 'KILL'): string[] {
  return [
    '-d',
    assertDistroName(distro),
    '--exec',
    '/bin/sh',
    '-c',
    `kill -s ${signal} "$1" 2>/dev/null || exit 1`,
    SCRIPT_ARGV0,
    String(assertLinuxPid(pid)),
  ];
}

export function buildDistroProbeArgs(distro: string): string[] {
  return ['-d', assertDistroName(distro), '--exec', '/bin/true'];
}

export function buildWslVersionArgs(): string[] {
  return ['--version'];
}

export function buildWslStatusArgs(): string[] {
  return ['--status'];
}
