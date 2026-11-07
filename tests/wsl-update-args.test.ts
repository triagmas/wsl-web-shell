/**
 * Issue #12 — WSL update commands.
 *
 * Two layers:
 * 1. argument construction and validation (never any network or WSL);
 * 2. a real end-to-end run of the shipped scripts under `/bin/sh` in throw-away
 *    directories with a fake `HOME` and a fake npm, which proves root expansion,
 *    the private cache, exact version comparison, staging, the swap, the rollback
 *    copy and the interruption recovery — without touching any installation.
 *
 * The end-to-end part needs a POSIX shell and is skipped on Windows.
 */
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  ACTIVATE_SCRIPT,
  INSPECT_SCRIPT,
  NPM_MARKER,
  NPM_PACKAGE,
  NPM_VIEW_SCRIPT,
  RESTORE_SCRIPT,
  STAGE_MARKER,
  STAGE_SCRIPT,
  buildActivateArgs,
  buildInspectArgs,
  buildNpmViewArgs,
  buildRestoreArgs,
  buildStageArgs,
  parseInspectLine,
  parseNpmMarker,
} from '../src/main/wsl/update-args.js';
import { ArgumentError } from '../src/main/wsl/args.js';

const ROOT = '~/.local/share/wsl-web-shell';
const NODE = '/home/u/.local/bin/node';
const TX = '20261107T101500Z-1a2b';

describe('update command construction', () => {
  it('checks the exact package version through /bin/sh', () => {
    const argv = buildNpmViewArgs({ distro: 'Ubuntu', isolationRoot: ROOT, version: '0.2.2-rc.1', nodePath: NODE });
    expect(argv.slice(0, 5)).toEqual(['-d', 'Ubuntu', '--exec', '/bin/sh', '-c']);
    expect(argv[5]).toBe(NPM_VIEW_SCRIPT);
    expect(argv.slice(6)).toEqual([ROOT, '0.2.2-rc.1', NODE]);
    expect(NPM_VIEW_SCRIPT).toContain(`"${NPM_PACKAGE}@$ver"`);
    // Read-only: the lookup must not install anything.
    expect(NPM_VIEW_SCRIPT).not.toContain('install');
  });

  it('expands a configured ~/ root in every script', () => {
    // A quoted tilde arrives as a positional parameter and is never expanded by
    // the shell, so each script has to do it itself (review blocker A).
    for (const script of [NPM_VIEW_SCRIPT, STAGE_SCRIPT, ACTIVATE_SCRIPT, RESTORE_SCRIPT, INSPECT_SCRIPT]) {
      expect(script).toContain('"~/"*) root="$HOME/${root_in#"~/"}" ;;');
      expect(script).toContain('root="$(cd "$root" && pwd -P)"');
      expect(script).toContain('rejected isolation root');
      expect(script).toContain('is a symlink');
    }
  });

  it('uses only the private npm cache', () => {
    for (const script of [NPM_VIEW_SCRIPT, STAGE_SCRIPT]) {
      expect(script).toContain('export npm_config_cache="$root/cache/npm"');
      expect(script).toContain('--cache "$root/cache/npm"');
      expect(script).not.toContain('~/.npm');
    }
  });

  it('compares versions exactly, never as a substring', () => {
    for (const script of [STAGE_SCRIPT, ACTIVATE_SCRIPT]) {
      expect(script).toContain('if [ "$staged" != "$ver" ]');
      expect(script).not.toContain('case "$staged" in *"$ver"*)');
    }
    expect(ACTIVATE_SCRIPT).toContain('if [ "$active" != "$ver" ]');
  });

  it('installs into the isolated prefix and keeps the previous tree', () => {
    const argv = buildStageArgs(
      { distro: 'Ubuntu', isolationRoot: ROOT, version: '0.2.2-rc.1', nodePath: NODE },
      '/usr/bin/npm',
      TX,
    );
    expect(argv.slice(6)).toEqual([ROOT, '0.2.2-rc.1', '/usr/bin/npm', NODE, TX]);
    expect(argv[5]).toBe(STAGE_SCRIPT);
    expect(STAGE_SCRIPT).toContain('--prefix "$stage"');
    expect(STAGE_SCRIPT).toContain('stage="$upd/stage-$tx"');
    expect(STAGE_SCRIPT).not.toContain('mv "$rt"');
    expect(ACTIVATE_SCRIPT).toContain('mv "$rt" "$prev"');
    expect(ACTIVATE_SCRIPT).toContain('mv "$stage" "$rt"');
    expect(ACTIVATE_SCRIPT).toContain('mv "$prev" "$rt"');
    // Nothing global is touched.
    for (const script of [STAGE_SCRIPT, ACTIVATE_SCRIPT, RESTORE_SCRIPT]) {
      expect(script).not.toContain('/usr/local/lib');
      expect(script).not.toContain('/usr/lib/node_modules');
    }
  });

  it('rejects unsafe values before they reach a command line', () => {
    expect(() => buildNpmViewArgs({ distro: 'Ubuntu', isolationRoot: ROOT, version: 'latest', nodePath: null })).toThrow(
      ArgumentError,
    );
    expect(() =>
      buildNpmViewArgs({ distro: 'Ubuntu', isolationRoot: ROOT, version: '0.2.2-rc.1; id', nodePath: null }),
    ).toThrow(ArgumentError);
    expect(() => buildNpmViewArgs({ distro: 'Ubuntu', isolationRoot: '~', version: '0.2.2-rc.1', nodePath: null })).toThrow(
      ArgumentError,
    );
    expect(() =>
      buildNpmViewArgs({ distro: 'bad distro', isolationRoot: ROOT, version: '0.2.2-rc.1', nodePath: null }),
    ).toThrow(ArgumentError);
    expect(() =>
      buildStageArgs({ distro: 'Ubuntu', isolationRoot: ROOT, version: '0.2.2-rc.1', nodePath: null }, 'npm; rm -rf /', TX),
    ).toThrow(ArgumentError);
    expect(() =>
      buildStageArgs({ distro: 'Ubuntu', isolationRoot: ROOT, version: '0.2.2-rc.1', nodePath: null }, '/usr/bin/npm', '../x'),
    ).toThrow(ArgumentError);
    expect(() => buildActivateArgs({ distro: 'Ubuntu', isolationRoot: ROOT, version: '0.2.2-rc.1', nodePath: null }, 'a b')).toThrow(
      ArgumentError,
    );
    expect(() => buildRestoreArgs('Ubuntu', ROOT, '../x', null)).toThrow(ArgumentError);
    expect(() => buildInspectArgs('Ubuntu', '~')).toThrow(ArgumentError);
  });

  it('parses the markers the scripts print', () => {
    expect(parseNpmMarker(`${NPM_MARKER} /usr/bin/npm`)).toBe('/usr/bin/npm');
    expect(parseNpmMarker(`${NPM_MARKER} npm`)).toBeNull();
    expect(parseNpmMarker('something else')).toBeNull();
    expect(parseInspectLine(`${'__wsl_web_shell_inspect__'} runtime=present`)).toEqual({ key: 'runtime', value: 'present' });
    expect(parseInspectLine(`${'__wsl_web_shell_inspect__'} previous=previous-x`)).toEqual({
      key: 'previous',
      value: 'previous-x',
    });
    expect(parseInspectLine('runtime=present')).toBeNull();
    expect(STAGE_MARKER).toContain('__wsl_web_shell_stage__');
  });
});

describe.skipIf(process.platform === 'win32')('update scripts in an isolated environment', () => {
  /**
   * Fake npm: understands exactly the global install invocation, writes a `dsh`
   * shim reporting the requested version, and records the arguments it saw so the
   * tests can assert the private cache and prefix.
   */
  const FAKE_NPM = `#!/bin/sh
set -eu
mode="$FAKE_NPM_MODE"
prefix=""
cache=""
target=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) prefix="$2"; shift 2;;
    --cache) cache="$2"; shift 2;;
    --global|--no-audit|--no-fund) shift;;
    --loglevel=*) shift;;
    *) target="$1"; shift;;
  esac
done
printf 'target=%s\\nprefix=%s\\ncache=%s\\n' "$target" "$prefix" "$cache" > "$FAKE_NPM_LOG"
if [ "$mode" = "fail" ]; then
  echo "npm ERR! network unreachable" >&2
  exit 7
fi
ver="$(printf '%s' "$target" | sed -e 's/.*@//')"
mkdir -p "$prefix/bin" "$prefix/lib/node_modules/@deepseek-ai/dsh"
if [ "$mode" = "wrong-version" ]; then ver="$FAKE_WRONG_VERSION"; fi
cat > "$prefix/bin/dsh" <<SHIM
#!/bin/sh
echo "$ver"
SHIM
chmod +x "$prefix/bin/dsh"
printf '{"name":"@deepseek-ai/dsh"}\\n' > "$prefix/lib/node_modules/@deepseek-ai/dsh/package.json"
`;

  interface Sandbox {
    base: string;
    home: string;
    root: string;
    npm: string;
    log: string;
  }

  /**
   * Creates a fake `$HOME` so a configured `~/…` root really has to be expanded.
   * `installed` is the version the current runtime reports.
   */
  async function sandbox(options: { mode?: string; installed?: string; withRuntime?: boolean } = {}): Promise<Sandbox> {
    const base = await mkdtemp(join(tmpdir(), 'wss-update-'));
    const home = join(base, 'home');
    const root = join(home, '.local', 'share', 'wsl-web-shell');
    await mkdir(join(root, 'runtime', 'bin'), { recursive: true });
    await mkdir(join(root, 'update'), { recursive: true });
    await mkdir(join(root, 'cache'), { recursive: true });
    if (options.withRuntime !== false) {
      const dsh = join(root, 'runtime', 'bin', 'dsh');
      await writeFile(dsh, `#!/bin/sh\necho "${options.installed ?? '0.2.1-rc.5'}"\n`, 'utf8');
      await chmod(dsh, 0o755);
    }
    const npm = join(root, 'runtime', 'bin', 'npm');
    await writeFile(npm, FAKE_NPM, 'utf8');
    await chmod(npm, 0o755);
    const log = join(base, 'npm-args.log');
    await writeFile(log, '', 'utf8');
    return { base, home, root, npm, log };
  }

  function run(script: string, args: string[], sandboxPath: Sandbox, env: Record<string, string> = {}) {
    return spawnSync('/bin/sh', ['-c', script, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: sandboxPath.home, FAKE_NPM_LOG: sandboxPath.log, ...env },
      timeout: 30_000,
    });
  }

  function version(binary: string): string {
    return spawnSync(binary, ['--version'], { encoding: 'utf8' }).stdout.trim();
  }

  it('expands the default ~/.local/share/wsl-web-shell root against $HOME (review blocker A)', async () => {
    const box = await sandbox();
    try {
      const result = run(STAGE_SCRIPT, [ROOT, '0.2.2-rc.1', box.npm, '-', TX], box, { FAKE_NPM_MODE: 'ok' });
      expect(result.status, result.stderr).toBe(0);
      // The staged tree landed below the fake $HOME, not in the real one, and the
      // runtime was not touched by staging.
      expect((await readdir(join(box.root, 'update'))).filter((name) => name.startsWith('stage-'))).toEqual([`stage-${TX}`]);
      expect(version(join(box.root, 'runtime', 'bin', 'dsh'))).toBe('0.2.1-rc.5');

      const activate = run(ACTIVATE_SCRIPT, [ROOT, '0.2.2-rc.1', TX, '-'], box);
      expect(activate.status, activate.stderr).toBe(0);
      expect(version(join(box.root, 'runtime', 'bin', 'dsh'))).toBe('0.2.2-rc.1');
      expect(version(join(box.root, 'update', `previous-${TX}`, 'bin', 'dsh'))).toBe('0.2.1-rc.5');
    } finally {
      await rm(box.base, { recursive: true, force: true });
    }
  });

  it('uses only the private npm cache and prefix', async () => {
    const box = await sandbox();
    try {
      const result = run(STAGE_SCRIPT, [ROOT, '0.2.2-rc.1', box.npm, '-', TX], box, { FAKE_NPM_MODE: 'ok' });
      expect(result.status, result.stderr).toBe(0);
      const seen = await readFile(box.log, 'utf8');
      expect(seen).toContain(`prefix=${box.root}/update/stage-${TX}`);
      expect(seen).toContain(`cache=${box.root}/cache/npm`);
      expect(seen).toContain(`target=${NPM_PACKAGE}@0.2.2-rc.1`);
      expect(seen).not.toContain('.npm');
    } finally {
      await rm(box.base, { recursive: true, force: true });
    }
  });

  it('refuses a symlinked isolation root or runtime (review blocker C)', async () => {
    const box = await sandbox();
    try {
      const link = join(box.home, 'link-root');
      await rm(join(box.base, 'elsewhere'), { recursive: true, force: true });
      await mkdir(join(box.base, 'elsewhere'), { recursive: true });
      const { symlink } = await import('node:fs/promises');
      await symlink(join(box.base, 'elsewhere'), link);
      const viaLink = run(STAGE_SCRIPT, ['~/link-root', '0.2.2-rc.1', box.npm, '-', TX], box, { FAKE_NPM_MODE: 'ok' });
      expect(viaLink.status).toBe(67);

      // And the runtime directory itself must not be a link out of the root.
      await rm(join(box.root, 'runtime'), { recursive: true, force: true });
      await symlink(join(box.base, 'elsewhere'), join(box.root, 'runtime'));
      const viaRuntime = run(STAGE_SCRIPT, [ROOT, '0.2.2-rc.1', box.npm, '-', TX], box, { FAKE_NPM_MODE: 'ok' });
      expect(viaRuntime.status).toBe(67);
      expect(viaRuntime.stderr).toContain('symlink');
    } finally {
      await rm(box.base, { recursive: true, force: true });
    }
  });

  it('rejects a version the staged executable does not report exactly', async () => {
    const box = await sandbox();
    try {
      // npm produces the old version: `0.2.2-rc.1` must not be satisfied by
      // `0.2.2-rc.10` or by the previous release.
      const wrong = run(STAGE_SCRIPT, [ROOT, '0.2.2-rc.1', box.npm, '-', TX], box, {
        FAKE_NPM_MODE: 'wrong-version',
        FAKE_WRONG_VERSION: '0.2.2-rc.10',
      });
      expect(wrong.status).toBe(71);
      expect(wrong.stderr).toContain('staged version check failed');
      expect(wrong.stderr).toContain('[0.2.2-rc.10]');
      const entries = await readdir(join(box.root, 'update'));
      expect(entries.filter((name) => name.startsWith('stage-'))).toHaveLength(0);
      expect(version(join(box.root, 'runtime', 'bin', 'dsh'))).toBe('0.2.1-rc.5');
    } finally {
      await rm(box.base, { recursive: true, force: true });
    }
  });

  it('keeps the old install when npm fails', async () => {
    const box = await sandbox();
    try {
      const result = run(STAGE_SCRIPT, [ROOT, '0.2.2-rc.1', box.npm, '-', TX], box, { FAKE_NPM_MODE: 'fail' });
      expect(result.status).toBe(7);
      expect(version(join(box.root, 'runtime', 'bin', 'dsh'))).toBe('0.2.1-rc.5');
      const entries = await readdir(join(box.root, 'update'));
      expect(entries.filter((name) => name.startsWith('previous-'))).toHaveLength(0);
      expect(entries.filter((name) => name.startsWith('stage-'))).toHaveLength(0);
    } finally {
      await rm(box.base, { recursive: true, force: true });
    }
  });

  it('stages without touching the runtime, then activates', async () => {
    const box = await sandbox();
    try {
      const staged = run(STAGE_SCRIPT, [ROOT, '0.2.2-rc.1', box.npm, '-', TX], box, { FAKE_NPM_MODE: 'ok' });
      expect(staged.status, staged.stderr).toBe(0);
      expect(staged.stdout).toContain(`${STAGE_MARKER} ${box.root}/update/stage-${TX}`);
      // Staging alone never replaces anything: the backend can keep running.
      expect(version(join(box.root, 'runtime', 'bin', 'dsh'))).toBe('0.2.1-rc.5');
      expect((await stat(join(box.root, 'update', `stage-${TX}`, 'bin', 'dsh'))).isFile()).toBe(true);

      const activated = run(ACTIVATE_SCRIPT, [ROOT, '0.2.2-rc.1', TX, '-'], box);
      expect(activated.status, activated.stderr).toBe(0);
      expect(version(join(box.root, 'runtime', 'bin', 'dsh'))).toBe('0.2.2-rc.1');
      expect((await readdir(join(box.root, 'update'))).filter((name) => name.startsWith('stage-'))).toHaveLength(0);
    } finally {
      await rm(box.base, { recursive: true, force: true });
    }
  });

  it('rolls back when the activated executable is wrong', async () => {
    const box = await sandbox();
    try {
      const staged = run(STAGE_SCRIPT, [ROOT, '0.2.2-rc.1', box.npm, '-', TX], box, { FAKE_NPM_MODE: 'ok' });
      expect(staged.status).toBe(0);
      // Break the staged executable after verification: activation must notice
      // and restore the previous install.
      await writeFile(join(box.root, 'update', `stage-${TX}`, 'bin', 'dsh'), '#!/bin/sh\necho "0.2.2-rc.10"\n', 'utf8');
      await chmod(join(box.root, 'update', `stage-${TX}`, 'bin', 'dsh'), 0o755);
      const activated = run(ACTIVATE_SCRIPT, [ROOT, '0.2.2-rc.1', TX, '-'], box);
      expect(activated.status).toBe(71);
      expect(version(join(box.root, 'runtime', 'bin', 'dsh'))).toBe('0.2.1-rc.5');
      expect((await readdir(join(box.root, 'update'))).filter((name) => name.startsWith('stage-'))).toHaveLength(0);
    } finally {
      await rm(box.base, { recursive: true, force: true });
    }
  });

  it('recovers an interruption at every swap boundary (review blocker B)', async () => {
    // Boundary 1: killed between `mv runtime previous` and `mv stage runtime`.
    const first = await sandbox();
    try {
      expect(run(STAGE_SCRIPT, [ROOT, '0.2.2-rc.1', first.npm, '-', TX], first, { FAKE_NPM_MODE: 'ok' }).status).toBe(0);
      const { rename } = await import('node:fs/promises');
      await rename(join(first.root, 'runtime'), join(first.root, 'update', `previous-${TX}`));

      const inspected = run(INSPECT_SCRIPT, [ROOT], first);
      expect(inspected.status, inspected.stderr).toBe(0);
      const report = new Map(
        inspected.stdout
          .split('\n')
          .map((line) => parseInspectLine(line))
          .filter((entry): entry is { key: string; value: string } => entry !== null)
          .map((entry) => [entry.key, entry.value]),
      );
      expect(report.get('runtime')).toBe('missing');
      expect(report.get('previous')).toBe(`previous-${TX}`);
      expect(report.get('stage')).toBe(`stage-${TX}`);

      const restored = run(RESTORE_SCRIPT, [ROOT, TX, '-'], first);
      expect(restored.status, restored.stderr).toBe(0);
      expect(version(join(first.root, 'runtime', 'bin', 'dsh'))).toBe('0.2.1-rc.5');
      expect(run(INSPECT_SCRIPT, [ROOT], first).stdout).toContain('runtime=present');
    } finally {
      await rm(first.base, { recursive: true, force: true });
    }

    // Boundary 2: killed after the swap but before the version was verified.
    const second = await sandbox();
    try {
      expect(run(STAGE_SCRIPT, [ROOT, '0.2.2-rc.1', second.npm, '-', TX], second, { FAKE_NPM_MODE: 'ok' }).status).toBe(0);
      const { rename } = await import('node:fs/promises');
      await rename(join(second.root, 'runtime'), join(second.root, 'update', `previous-${TX}`));
      await rename(join(second.root, 'update', `stage-${TX}`), join(second.root, 'runtime'));
      // The new tree is in place but reports another version: restore wins.
      await writeFile(join(second.root, 'runtime', 'bin', 'dsh'), '#!/bin/sh\necho "0.2.2-rc.10"\n', 'utf8');
      await chmod(join(second.root, 'runtime', 'bin', 'dsh'), 0o755);

      const restored = run(RESTORE_SCRIPT, [ROOT, TX, '-'], second);
      expect(restored.status, restored.stderr).toBe(0);
      expect(version(join(second.root, 'runtime', 'bin', 'dsh'))).toBe('0.2.1-rc.5');
    } finally {
      await rm(second.base, { recursive: true, force: true });
    }
  });

  it('is idempotent: a second restore changes nothing', async () => {
    const box = await sandbox();
    try {
      const first = run(RESTORE_SCRIPT, [ROOT, TX, '-'], box);
      expect(first.status, first.stderr).toBe(0);
      expect(version(join(box.root, 'runtime', 'bin', 'dsh'))).toBe('0.2.1-rc.5');
      const second = run(RESTORE_SCRIPT, [ROOT, TX, '-'], box);
      expect(second.status).toBe(0);
      expect(version(join(box.root, 'runtime', 'bin', 'dsh'))).toBe('0.2.1-rc.5');
    } finally {
      await rm(box.base, { recursive: true, force: true });
    }
  });

  it('reports a missing runtime to the inspect step', async () => {
    const box = await sandbox({ withRuntime: false });
    try {
      const inspected = run(INSPECT_SCRIPT, [ROOT], box);
      expect(inspected.status, inspected.stderr).toBe(0);
      expect(inspected.stdout).toContain('runtime=missing');
      expect(inspected.stdout).not.toContain('version=');
    } finally {
      await rm(box.base, { recursive: true, force: true });
    }
  });
});
