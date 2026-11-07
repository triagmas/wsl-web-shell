/**
 * WSL commands for the one-click update (issue #12).
 *
 * Every step runs as `wsl.exe -d <distro> --exec /bin/sh -c <script> <args…>`, so
 * no user value is ever interpolated into shell text: each one arrives as a
 * positional parameter, is validated in TypeScript and is validated again in the
 * script before it is used.
 *
 * Steps:
 * 1. `NPM_VIEW_SCRIPT` — read-only: does the exact version exist on npm?
 * 2. `STAGE_SCRIPT` — install that version into `<root>/update/stage-<tx>`,
 *    verify the staged executable reports exactly that version.
 * 3. `ACTIVATE_SCRIPT` — swap `runtime/` with the staged tree, keep the old one
 *    as `update/previous-<tx>`, verify the activated executable.
 * 4. `RESTORE_SCRIPT` — idempotent rollback used by the failure path and by the
 *    journal recovery after an interrupted swap.
 * 5. `INSPECT_SCRIPT` — read-only state report used to decide that recovery.
 *
 * Shared rules enforced by every script:
 * - a configured `~/…` root is expanded against `$HOME` (a quoted tilde passed as
 *   a positional argument is *not* expanded by the shell) and the result is
 *   canonicalised with `pwd -P`;
 * - `runtime`, `update` and `cache` must not be symlinks, so nothing is written
 *   through a link that points outside the dedicated root;
 * - the npm cache is the private `<root>/cache/npm`, never `~/.npm`;
 * - versions are compared exactly, never as substrings.
 */
import { ArgumentError, assertDistroName } from './args.js';
import { isValidIsolationRoot, isValidRuntimeBinary } from '../core/isolation.js';
import { isExactVersion, isValidTransactionId } from '../core/update.js';

export const NPM_PACKAGE = '@deepseek-ai/dsh' as const;

/** Marker printed by the scripts right before the resolved npm path. */
export const NPM_MARKER = '__wsl_web_shell_npm__';
/** Marker prefixes for the key=value report lines the scripts print. */
export const STAGE_MARKER = '__wsl_web_shell_stage__';
export const INSPECT_MARKER = '__wsl_web_shell_inspect__';

/**
 * Expand and validate the isolation root, then refuse symlinked components.
 *
 * `$0` is the configured root; `root` is left as the canonical absolute path.
 */
const ROOT_SETUP = [
  'root_in="$0"',
  'case "$root_in" in',
  '"~"|"~/") echo "update: the isolation root must be a dedicated subtree" >&2; exit 66 ;;',
  '"~/"*) root="$HOME/${root_in#"~/"}" ;;',
  '/*) root="$root_in" ;;',
  '*) echo "update: rejected isolation root" >&2; exit 64 ;;',
  'esac',
  'case "$root" in *"//"*|*"/../"*|*"/./"*|*"/.."|*"/.") echo "update: rejected isolation root" >&2; exit 66 ;; esac',
  'case "$root" in *[!A-Za-z0-9._~/@+-]*) echo "update: rejected isolation root" >&2; exit 64 ;; esac',
  'case "${root%/}" in */*/*) ;; *) echo "update: the isolation root must be a dedicated subtree" >&2; exit 66 ;; esac',
  'if [ -L "$root" ]; then echo "update: the isolation root is a symlink" >&2; exit 67; fi',
  'if [ ! -d "$root" ]; then echo "update: the isolated root is missing" >&2; exit 68; fi',
  // Canonical form: the journal, the ownership check and the scripts must agree
  // on one path even when `$HOME` itself is a symlink.
  'root="$(cd "$root" && pwd -P)" || { echo "update: the isolated root is not accessible" >&2; exit 68; }',
  'case "$root" in *[!A-Za-z0-9._~/@+-]*) echo "update: rejected isolation root" >&2; exit 64 ;; esac',
  'for c in runtime update cache; do',
  'if [ -L "$root/$c" ]; then echo "update: $c is a symlink, refusing to write through it" >&2; exit 67; fi',
  'done',
].join('\n');

/** Shared `dsh --version` reader with an exact-comparison result. */
const VERSION_HELPER = [
  // First line, first token, "dsh " label and a leading "v" removed. Nothing
  // else is stripped, so `0.2.2-rc.1` never matches `0.2.2-rc.10`.
  'version_of() {',
  'out="$("$1" --version 2>/dev/null | tr -d "\\r" | head -n 1)" || out=""',
  'out="$(printf "%s" "$out" | sed -e "s/^[[:space:]]*//" -e "s/[[:space:]]*$//")"',
  'case "$out" in dsh[[:space:]]*) out="${out#dsh}" ;; esac',
  'out="$(printf "%s" "$out" | awk "{print \\$1}")"',
  'out="${out#v}"',
  'printf "%s" "$out"',
  '}',
].join('\n');

/** npm lookup order: the private runtime first, then the usual system paths. */
const NPM_LOOKUP = [
  'npm_bin=""',
  'for c in "$root/runtime/bin/npm" "$HOME/.local/bin/npm" /usr/local/bin/npm /usr/bin/npm /bin/npm; do',
  'if [ -x "$c" ]; then npm_bin="$c"; break; fi',
  'done',
  'if [ -z "$npm_bin" ] && command -v npm >/dev/null 2>&1; then npm_bin="$(command -v npm)"; fi',
].join('\n');

/** Shared npm environment: private cache, no prompts, no global metadata. */
const NPM_ENV = [
  'export npm_config_cache="$root/cache/npm"',
  'export npm_config_update_notifier=false',
  'export npm_config_fund=false',
  'export npm_config_audit=false',
  'export npm_config_progress=false',
].join('\n');

/**
 * Ask npm for the exact version. Read-only: `npm view` only queries the registry
 * and writes to the private cache inside the isolated root.
 *
 * `$0` = isolation root, `$1` = version, `$2` = node binary (or `-`).
 */
export const NPM_VIEW_SCRIPT = [
  'set -eu',
  'root_in="$0"; ver="$1"; node="$2"',
  'case "$ver" in ""|*[!0-9A-Za-z.-]*) echo "update: rejected version" >&2; exit 64 ;; esac',
  'if [ "$node" != "-" ]; then PATH="$(dirname "$node"):$PATH"; export PATH; fi',
  ROOT_SETUP,
  'if [ ! -x "$root/runtime/bin/dsh" ]; then echo "update: the isolated runtime is missing" >&2; exit 68; fi',
  NPM_LOOKUP,
  '[ -n "$npm_bin" ] || { echo "wsl-web-shell: npm was not found in this distribution" >&2; exit 69; }',
  'mkdir -p "$root/cache/npm"',
  NPM_ENV,
  'printf "%s %s\\n" "' + NPM_MARKER + '" "$npm_bin"',
  `"$npm_bin" view "${NPM_PACKAGE}@$ver" version --json --cache "$root/cache/npm" 2>&1`,
].join('\n');

/**
 * Install the exact version into a staging prefix and verify it.
 *
 * The runtime is not touched: the backend keeps running while npm works.
 *
 * Exit codes: 64 bad argument, 66 unsafe root, 67 symlink, 68 missing
 * root/runtime, 69 no npm, 70 no staged executable, 71 staged version mismatch.
 *
 * `$0` = root, `$1` = version, `$2` = npm binary, `$3` = node (or `-`),
 * `$4` = transaction id.
 */
export const STAGE_SCRIPT = [
  'set -eu',
  'root_in="$0"; ver="$1"; npm_bin="$2"; node="$3"; tx="$4"',
  'case "$ver" in ""|*[!0-9A-Za-z.-]*) echo "update: rejected version" >&2; exit 64 ;; esac',
  'case "$tx" in ""|*[!0-9A-Za-z-]*) echo "update: rejected transaction id" >&2; exit 64 ;; esac',
  'if [ "$node" != "-" ]; then PATH="$(dirname "$node"):$PATH"; export PATH; fi',
  ROOT_SETUP,
  'rt="$root/runtime"; upd="$root/update"',
  'stage="$upd/stage-$tx"',
  'if [ ! -x "$rt/bin/dsh" ]; then echo "update: the isolated runtime is missing" >&2; exit 68; fi',
  'if [ -z "$npm_bin" ] || [ ! -x "$npm_bin" ]; then echo "update: npm was not found in this distribution" >&2; exit 69; fi',
  VERSION_HELPER,
  'mkdir -p "$upd" "$root/cache/npm"',
  NPM_ENV,
  'echo "update: package ' + NPM_PACKAGE + '@$ver"',
  'echo "update: staging prefix $stage"',
  'echo "update: npm $npm_bin"',
  'rm -rf "$stage"',
  'status=0',
  '"$npm_bin" install --global --prefix "$stage" --cache "$root/cache/npm" --no-audit --no-fund --loglevel=warn "' + NPM_PACKAGE + '@$ver" || status=$?',
  'if [ "$status" -ne 0 ]; then echo "update: install failed with exit code $status" >&2; rm -rf "$stage"; exit "$status"; fi',
  'if [ ! -x "$stage/bin/dsh" ]; then echo "update: the staged install has no dsh executable" >&2; rm -rf "$stage"; exit 70; fi',
  'echo "update: verifying the staged installation"',
  'staged="$(version_of "$stage/bin/dsh")" || staged=""',
  'if [ "$staged" != "$ver" ]; then echo "update: staged version check failed: got [$staged], expected [$ver]" >&2; rm -rf "$stage"; exit 71; fi',
  'echo "update: staged version $staged"',
  'printf "%s %s\\n" "' + STAGE_MARKER + '" "$stage"',
].join('\n');

/**
 * Swap the staged tree into `runtime/`, keeping the old tree for rollback.
 *
 * Called only after the app-owned backend was stopped: nothing may be running
 * from `runtime/` while it is renamed.
 *
 * Exit codes: 72 activated version mismatch (previous restored), 73 activation
 * move failed (previous restored), 74 the staged installation is missing.
 *
 * `$0` = root, `$1` = version, `$2` = transaction id, `$3` = node (or `-`).
 */
export const ACTIVATE_SCRIPT = [
  'set -eu',
  'root_in="$0"; ver="$1"; tx="$2"; node="$3"',
  'case "$ver" in ""|*[!0-9A-Za-z.-]*) echo "update: rejected version" >&2; exit 64 ;; esac',
  'case "$tx" in ""|*[!0-9A-Za-z-]*) echo "update: rejected transaction id" >&2; exit 64 ;; esac',
  'if [ "$node" != "-" ]; then PATH="$(dirname "$node"):$PATH"; export PATH; fi',
  ROOT_SETUP,
  VERSION_HELPER,
  'rt="$root/runtime"; upd="$root/update"',
  'stage="$upd/stage-$tx"; prev="$upd/previous-$tx"',
  'if [ ! -x "$stage/bin/dsh" ]; then echo "update: the staged installation is missing" >&2; exit 74; fi',
  'staged="$(version_of "$stage/bin/dsh")" || staged=""',
  'if [ "$staged" != "$ver" ]; then echo "update: staged version check failed: got [$staged], expected [$ver]" >&2; rm -rf "$stage"; exit 71; fi',
  'echo "update: activating"',
  'rm -rf "$prev"',
  'mv "$rt" "$prev"',
  'if ! mv "$stage" "$rt"; then',
  'echo "update: activation failed, restoring the previous install" >&2',
  'mv "$prev" "$rt" || true',
  'exit 73',
  'fi',
  'active="$(version_of "$rt/bin/dsh")" || active=""',
  'if [ "$active" != "$ver" ]; then',
  'echo "update: activated version check failed: got [$active], expected [$ver]" >&2',
  'echo "update: restoring the previous install" >&2',
  'rm -rf "$rt"',
  'mv "$prev" "$rt"',
  'exit 72',
  'fi',
  'echo "update: installed version $active"',
  'echo "update: previous installation kept at $prev"',
  // Keep exactly one rollback copy: the one just created.
  'for old in $(ls -1d "$upd"/previous-* 2>/dev/null | sort -r | sed -e "1d"); do rm -rf "$old"; done',
  'printf "%s %s\\n" "' + STAGE_MARKER + '" "$rt"',
].join('\n');

/**
 * Restore `update/previous-<tx>` back to `runtime/`. Idempotent.
 *
 * Exit codes: 74 nothing could be restored.
 *
 * `$0` = root, `$1` = transaction id, `$2` = node (or `-`).
 */
export const RESTORE_SCRIPT = [
  'set -eu',
  'root_in="$0"; tx="$1"; node="$2"',
  'case "$tx" in ""|*[!0-9A-Za-z-]*) echo "update: rejected transaction id" >&2; exit 64 ;; esac',
  'if [ "$node" != "-" ]; then PATH="$(dirname "$node"):$PATH"; export PATH; fi',
  ROOT_SETUP,
  'rt="$root/runtime"; upd="$root/update"',
  'stage="$upd/stage-$tx"; prev="$upd/previous-$tx"',
  'echo "update: restoring the previous installation"',
  'if [ -d "$prev" ]; then',
  'if [ -e "$rt" ] || [ -L "$rt" ]; then rm -rf "$rt"; fi',
  'mv "$prev" "$rt"',
  'elif [ -d "$rt" ]; then',
  'echo "update: the runtime is already in place"',
  'elif [ -d "$stage" ]; then',
  'echo "update: no previous installation, activating the staged one" >&2',
  'mv "$stage" "$rt"',
  'else',
  'echo "update: nothing to restore" >&2',
  'exit 74',
  'fi',
  'echo "update: rollout reverted"',
].join('\n');

/**
 * Read-only state report used by the journal recovery.
 *
 * `$0` = isolation root.
 */
export const INSPECT_SCRIPT = [
  'set -eu',
  'root_in="$0"',
  ROOT_SETUP,
  VERSION_HELPER,
  'rt="$root/runtime"; upd="$root/update"',
  'printf "%s runtime=%s\\n" "' + INSPECT_MARKER + '" "$([ -x "$rt/bin/dsh" ] && echo present || echo missing)"',
  'if [ -x "$rt/bin/dsh" ]; then printf "%s version=%s\\n" "' + INSPECT_MARKER + '" "$(version_of "$rt/bin/dsh")"; fi',
  'for name in previous stage; do',
  'dir=""',
  'for candidate in $(ls -1d "$upd/$name"-* 2>/dev/null | sort -r); do',
  'dir="$candidate"',
  'break',
  'done',
  'if [ -n "$dir" ]; then printf "%s %s=%s\\n" "' + INSPECT_MARKER + '" "$name" "${dir##*/}"; fi',
  'done',
].join('\n');

export interface UpdateScriptRequest {
  distro: string;
  isolationRoot: string;
  version: string;
  nodePath: string | null;
}

interface NormalisedRequest {
  distro: string;
  root: string;
  version: string;
  node: string;
}

function assertRequest(request: UpdateScriptRequest): NormalisedRequest {
  const distro = assertDistroName(request.distro);
  if (!isValidIsolationRoot(request.isolationRoot)) throw new ArgumentError('invalid-isolation-root');
  if (!isExactVersion(request.version)) throw new ArgumentError('invalid-version');
  if (request.nodePath !== null && !isValidRuntimeBinary(request.nodePath)) {
    throw new ArgumentError('invalid-runtime-binary');
  }
  return { distro, root: request.isolationRoot, version: request.version, node: request.nodePath ?? '-' };
}

function assertTransaction(transaction: string): string {
  if (!isValidTransactionId(transaction)) throw new ArgumentError('invalid-transaction');
  return transaction;
}

/** Read-only existence check of one exact published version. */
export function buildNpmViewArgs(request: UpdateScriptRequest): string[] {
  const { distro, root, version, node } = assertRequest(request);
  return ['-d', distro, '--exec', '/bin/sh', '-c', NPM_VIEW_SCRIPT, root, version, node];
}

/** Install exactly `version` into a staging prefix inside the isolated root. */
export function buildStageArgs(
  request: UpdateScriptRequest,
  npmPath: string,
  transaction: string,
): string[] {
  const { distro, root, version, node } = assertRequest(request);
  if (!isValidRuntimeBinary(npmPath)) throw new ArgumentError('invalid-runtime-binary');
  return [
    '-d',
    distro,
    '--exec',
    '/bin/sh',
    '-c',
    STAGE_SCRIPT,
    root,
    version,
    npmPath,
    node,
    assertTransaction(transaction),
  ];
}

/** Swap the staged tree into `runtime/`, keeping the previous one. */
export function buildActivateArgs(
  request: UpdateScriptRequest,
  transaction: string,
): string[] {
  const { distro, root, version, node } = assertRequest(request);
  return ['-d', distro, '--exec', '/bin/sh', '-c', ACTIVATE_SCRIPT, root, version, assertTransaction(transaction), node];
}

/** Restore the previous installation (failure path and journal recovery). */
export function buildRestoreArgs(distro: string, isolationRoot: string, transaction: string, nodePath: string | null): string[] {
  const name = assertDistroName(distro);
  if (!isValidIsolationRoot(isolationRoot)) throw new ArgumentError('invalid-isolation-root');
  if (nodePath !== null && !isValidRuntimeBinary(nodePath)) throw new ArgumentError('invalid-runtime-binary');
  return ['-d', name, '--exec', '/bin/sh', '-c', RESTORE_SCRIPT, isolationRoot, assertTransaction(transaction), nodePath ?? '-'];
}

/** Read-only report of what the isolated root contains right now. */
export function buildInspectArgs(distro: string, isolationRoot: string): string[] {
  const name = assertDistroName(distro);
  if (!isValidIsolationRoot(isolationRoot)) throw new ArgumentError('invalid-isolation-root');
  return ['-d', name, '--exec', '/bin/sh', '-c', INSPECT_SCRIPT, isolationRoot];
}

const NPM_LINE = new RegExp(`^${NPM_MARKER} (.+)$`);

/** Parse the npm path announced by the lookup script. */
export function parseNpmMarker(line: string): string | null {
  const match = NPM_LINE.exec(line.trim());
  if (match === null) return null;
  const path = match[1]?.trim() ?? '';
  return isValidRuntimeBinary(path) ? path : null;
}

/** Parse a `key=value` line of the inspect report. */
export function parseInspectLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(`${INSPECT_MARKER} `)) return null;
  const body = trimmed.slice(INSPECT_MARKER.length + 1);
  const index = body.indexOf('=');
  if (index <= 0) return null;
  return { key: body.slice(0, index), value: body.slice(index + 1) };
}

/** Parse the directory the staging script created. */
export function parseStageMarker(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(`${STAGE_MARKER} `)) return null;
  const path = trimmed.slice(STAGE_MARKER.length + 1).trim();
  return path === '' ? null : path;
}
