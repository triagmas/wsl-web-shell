/**
 * R02-B0/B0.1 regression suite: isolated backend environment.
 *
 * Covers root validation (dedicated subtree only, no `/`, `~`, traversal or
 * shell-significant characters), the exact launcher arguments, environment
 * delivery inside the distribution, the working directory handling, and real
 * execution of the preparation/launch scripts inside a throw-away sandbox
 * (symlink redirection, pre-existing content, missing workspace).
 */
import { describe, expect, it } from 'vitest';
import { Supervisor } from '../src/main/core/supervisor.js';
import {
  ISOLATION_DISABLED,
  ISOLATION_ROOT_MIN_DEPTH,
  buildIsolationPlan,
  isValidIsolationRoot,
  isValidRuntimeBinary,
  isolationRootArg,
  normalizeIsolationRoot,
  resolveLaunchWorkspace,
} from '../src/main/core/isolation.js';
import { normalizeConfig, applyConfigPatch, requiresRestart } from '../src/main/core/config.js';
import {
  PREPARE_ISOLATION_SCRIPT,
  PROBE_PROCESS_SCRIPT,
  RESOLVE_RUNTIME_SCRIPT,
  SCRIPT_ARGV0,
  START_WRAPPER_SCRIPT,
  ArgumentError,
  buildPrepareIsolationArgs,
  buildProbeProcessArgs,
  buildResolveRuntimeArgs,
  buildStartServerArgs,
} from '../src/main/wsl/args.js';
import { parseProcessProbe, parseRuntimeProbe } from '../src/main/wsl/output.js';
import { DEFAULT_CONFIG, ISOLATION_ROOT_DEFAULT } from '../src/shared/types.js';
import { createHarness, lastStatus } from './helpers.js';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = '~/.local/share/wsl-web-shell';
const launchBase = {
  distro: 'Ubuntu',
  dshPath: '/opt/wsl-web-shell/runtime/bin/dsh',
  port: 3080,
  workspace: '~',
  isolationRoot: ROOT,
  nodePath: '/usr/bin/node',
};

describe('isolation root validation', () => {
  it('accepts dedicated subtrees only', () => {
    for (const root of [ISOLATION_ROOT_DEFAULT, ROOT, '/srv/wsl-web-shell', '/opt/apps/wsl-web-shell', '/home/me/.local/share/wsl-web-shell']) {
      expect(isValidIsolationRoot(root)).toBe(true);
    }
    expect(ISOLATION_ROOT_MIN_DEPTH).toBe(2);
  });

  it('rejects the filesystem root, the home directory and one-level roots', () => {
    for (const root of ['/', '//', '~', '~/', '~/x', '/srv', '/srv/', '/opt', '/home', '/tmp']) {
      expect(isValidIsolationRoot(root)).toBe(false);
    }
  });

  it('rejects traversal and structural representations', () => {
    for (const root of [
      '~/.local/../secret',
      '/srv/../etc',
      '~/a/./b',
      '/srv//app',
      '//srv/app',
      '~/..',
      '/..',
      './relative',
      'relative/path',
      '~user/app',
      '~/a/b/../../../etc',
    ]) {
      expect(isValidIsolationRoot(root)).toBe(false);
    }
  });

  it('rejects shell-significant characters and non-strings', () => {
    const rejected: unknown[] = [
      '',
      ' ',
      '/srv/a b',
      '/srv/$(id)',
      '/srv/`id`',
      '/srv/a;rm -rf /',
      '/srv/a|b',
      '/srv/a&b',
      '/srv/a"b',
      "/srv/a'b",
      'C:\\Users\\me',
      '/srv/a\nb',
      '/srv/a\tb',
      `/${'a'.repeat(600)}/b`,
      42,
      null,
      undefined,
    ];
    for (const root of rejected) expect(isValidIsolationRoot(root)).toBe(false);
  });

  it('accepts a single trailing slash but hands out a canonical value', () => {
    expect(isValidIsolationRoot('~/a/b/')).toBe(true);
    expect(normalizeIsolationRoot('~/a/b/')).toBe('~/a/b');
    expect(normalizeIsolationRoot('/srv/app//')).toBe('/srv/app');
  });

  it('accepts only absolute sandbox-free runtime binaries', () => {
    expect(isValidRuntimeBinary('/usr/bin/node')).toBe(true);
    expect(isValidRuntimeBinary('/opt/wsl-web-shell/runtime/bin/node')).toBe(true);
    // Resolved binaries are absolute; a tilde form is never a runtime binary.
    for (const value of ['node', `${ROOT}/runtime/bin/node`, '/usr/../bin/node', '/usr/bin/node --inspect', '/usr/bin/no de']) {
      expect(isValidRuntimeBinary(value)).toBe(false);
    }
  });
});

describe('isolation plan', () => {
  it('derives every path below the single root without duplicate separators', () => {
    const plan = buildIsolationPlan({ enabled: true, root: `${ROOT}/` });
    expect(plan).toEqual({
      enabled: true,
      root: ROOT,
      runtimeBin: `${ROOT}/runtime/bin`,
      dshHome: `${ROOT}/dsh-home`,
      agentsHome: `${ROOT}/agents`,
      cacheHome: `${ROOT}/cache`,
      tempDir: `${ROOT}/tmp`,
      workspace: `${ROOT}/workspace`,
    });
    expect(plan.runtimeBin).not.toContain('//');
  });

  it('falls back to the default root when the configured value is empty', () => {
    expect(buildIsolationPlan({ enabled: true, root: '' }).root).toBe(ISOLATION_ROOT_DEFAULT);
  });

  it('refuses to build an enabled plan from any unsafe root', () => {
    for (const root of ['/', '~', '~/x', '/srv/a;b', '~/a/../b']) {
      expect(() => buildIsolationPlan({ enabled: true, root })).toThrow(/invalid-isolation-root/);
    }
    // A disabled plan never reaches the launcher, so nothing is validated there.
    expect(buildIsolationPlan({ enabled: false, root: '/srv/a;b' }).enabled).toBe(false);
  });

  it('uses the isolated workspace for the bare ~ default only', () => {
    const plan = buildIsolationPlan({ enabled: true, root: ROOT });
    expect(resolveLaunchWorkspace('~', plan)).toBe(`${ROOT}/workspace`);
    expect(resolveLaunchWorkspace('~/', plan)).toBe(`${ROOT}/workspace`);
    expect(resolveLaunchWorkspace('~/projects/app', plan)).toBe('~/projects/app');
    expect(resolveLaunchWorkspace('/srv/app', plan)).toBe('/srv/app');
    const off = buildIsolationPlan({ enabled: false, root: ROOT });
    expect(resolveLaunchWorkspace('~', off)).toBe('~');
  });

  it('maps the plan onto the launcher argument', () => {
    const on = buildIsolationPlan({ enabled: true, root: ROOT });
    expect(isolationRootArg(on)).toBe(ROOT);
    const off = buildIsolationPlan({ enabled: false, root: ROOT });
    expect(isolationRootArg(off)).toBe(ISOLATION_DISABLED);
  });
});

describe('launcher environment', () => {
  it('exports every isolation variable inside the distribution', () => {
    for (const line of [
      'export DSH_HOME="$iroot/dsh-home"',
      'export DSH_AGENTS_HOME="$iroot/agents"',
      'export XDG_CACHE_HOME="$iroot/cache"',
      'export TMPDIR="$iroot/tmp"',
      'export WSL_WEB_SHELL_ISOLATION_ROOT="$iroot"',
    ]) {
      expect(START_WRAPPER_SCRIPT).toContain(line);
    }
    // The isolated runtime always wins the PATH prefix.
    expect(START_WRAPPER_SCRIPT).toContain('export PATH="$iroot/runtime/bin:$(dirname "$node"):$PATH"');
  });

  it('re-validates the root before exporting anything', () => {
    expect(START_WRAPPER_SCRIPT).toContain('[ "$root" = "/" ]');
    expect(START_WRAPPER_SCRIPT).toContain('exit 66');
    expect(START_WRAPPER_SCRIPT).toContain('exit 67');
    expect(START_WRAPPER_SCRIPT).not.toContain('WSLENV');
  });

  it('enters the workspace with the shell instead of wsl.exe --cd', () => {
    expect(START_WRAPPER_SCRIPT).toContain('cd "$ws" || exit 65');
    expect(buildStartServerArgs(launchBase)).not.toContain('--cd');
    // A tilde-prefixed subpath is expanded by bash, which is verifiable.
    expect(START_WRAPPER_SCRIPT).toContain('ws="$HOME/${ws#"~/"}');
  });

  it('keeps values out of the script text and passes them as positional arguments', () => {
    const argv = buildStartServerArgs(launchBase);
    expect(argv).toEqual([
      '-d',
      'Ubuntu',
      '--exec',
      '/bin/bash',
      '-c',
      START_WRAPPER_SCRIPT,
      '/opt/wsl-web-shell/runtime/bin/dsh',
      '127.0.0.1',
      '3080',
      ROOT,
      '/usr/bin/node',
      '~',
    ]);
    for (const value of [ROOT, '/usr/bin/node', '3080', '/opt/wsl-web-shell/runtime/bin/dsh']) {
      expect(START_WRAPPER_SCRIPT).not.toContain(value);
    }
  });

  it('marks isolation as disabled without any variable setup', () => {
    const argv = buildStartServerArgs({ ...launchBase, isolationRoot: ISOLATION_DISABLED, nodePath: null });
    expect(argv.slice(-3)).toEqual([ISOLATION_DISABLED, ISOLATION_DISABLED, '~']);
  });

  it('rejects unsafe isolation values before any process is spawned', () => {
    for (const isolationRoot of ['/', '~', '~/x', '/srv/a b', '/srv/../x', 'relative', '/srv/a;id']) {
      expect(() => buildStartServerArgs({ ...launchBase, isolationRoot })).toThrow(ArgumentError);
    }
    for (const nodePath of ['node', '/usr/bin/node -e x', '/usr/../bin/node']) {
      expect(() => buildStartServerArgs({ ...launchBase, nodePath })).toThrow(ArgumentError);
    }
  });

  it('rejects workspace paths that could leave the intended project', () => {
    for (const workspace of ['~/a/../..', '/srv/./x', '/srv//x', '~/../etc', 'relative/path', '/', '']) {
      expect(() => buildStartServerArgs({ ...launchBase, workspace })).toThrow(ArgumentError);
    }
    for (const workspace of ['~', '~/', '~/projects/app', '/srv/app', '/home/me/work']) {
      expect(() => buildStartServerArgs({ ...launchBase, workspace })).not.toThrow();
    }
  });

  it('never exposes the launch token or a bind address wider than loopback', () => {
    const argv = buildStartServerArgs(launchBase).join(' ');
    expect(argv).not.toContain('token');
    expect(argv).toContain('--no-open');
    expect(argv).not.toContain('0.0.0.0');
  });
});

describe('environment preparation', () => {
  it('creates only the directories of the plan and nothing else', () => {
    expect(PREPARE_ISOLATION_SCRIPT).toContain('for d in runtime/bin dsh-home agents cache tmp workspace; do');
    expect(PREPARE_ISOLATION_SCRIPT).toContain('umask 077');
    expect(PREPARE_ISOLATION_SCRIPT).not.toMatch(/\b(apt|dpkg|npm|pnpm|pip|curl|wget|rm|mv|cp|chmod|chown)\b/);
    expect(PREPARE_ISOLATION_SCRIPT).not.toContain('sudo');
  });

  it('checks for symlink redirection before and after every write', () => {
    expect(PREPARE_ISOLATION_SCRIPT).toContain('if [ -L "$walked" ]');
    expect(PREPARE_ISOLATION_SCRIPT).toContain('[ ! -L "$expected" ]');
    // Each managed component is checked before `mkdir -p` can follow it.
    expect(PREPARE_ISOLATION_SCRIPT).toContain('if [ -L "$cur" ]');
    expect(PREPARE_ISOLATION_SCRIPT).toContain('[ "$(cd "$expected/$d" && pwd -P)" = "$expected/$d" ]');
  });

  it('validates the root before it reaches the shell', () => {
    const argv = buildPrepareIsolationArgs('Ubuntu', ROOT);
    expect(argv).toEqual(['-d', 'Ubuntu', '--exec', '/bin/sh', '-c', PREPARE_ISOLATION_SCRIPT, SCRIPT_ARGV0, ROOT]);
    for (const root of ['/', '~', '~/x', '~/a/../../etc', '/srv/a b']) {
      expect(() => buildPrepareIsolationArgs('Ubuntu', root)).toThrow(ArgumentError);
    }
  });

  it('resolves dsh/node read-only and prefers the isolated runtime', () => {
    const argv = buildResolveRuntimeArgs('Ubuntu', ROOT);
    expect(argv.slice(0, 6)).toEqual(['-d', 'Ubuntu', '--exec', '/bin/sh', '-c', RESOLVE_RUNTIME_SCRIPT]);
    expect(argv.slice(-2)).toEqual([SCRIPT_ARGV0, ROOT]);
    const isolatedIndex = RESOLVE_RUNTIME_SCRIPT.indexOf('runtime/bin/dsh');
    const systemIndex = RESOLVE_RUNTIME_SCRIPT.indexOf('/usr/local/bin/dsh');
    expect(isolatedIndex).toBeGreaterThan(-1);
    expect(isolatedIndex).toBeLessThan(systemIndex);
    expect(RESOLVE_RUNTIME_SCRIPT).not.toMatch(/\b(apt|apt-get|dpkg|curl|wget|pnpm)\b/);
    expect(RESOLVE_RUNTIME_SCRIPT).not.toMatch(/npm\s+(i|in|install|add)\b/);
  });

  it('parses the runtime probe and drops unsafe values', () => {
    expect(parseRuntimeProbe('dsh=/usr/bin/dsh\nnode=/usr/bin/node\n')).toEqual({
      dshPath: '/usr/bin/dsh',
      nodePath: '/usr/bin/node',
      rootPath: null,
    });
    expect(parseRuntimeProbe('dsh=\nnode=\n')).toEqual({ dshPath: null, nodePath: null, rootPath: null });
    expect(parseRuntimeProbe('dsh=relative/dsh\nnode=/usr/../node\n')).toEqual({
      dshPath: null,
      nodePath: null,
      rootPath: null,
    });
    expect(parseRuntimeProbe('garbage\r\ndsh=/opt/dsh\r\n')).toEqual({
      dshPath: '/opt/dsh',
      nodePath: null,
      rootPath: null,
    });
    // The canonical isolation root is reported by the same probe (issue #12).
    expect(parseRuntimeProbe('root=/home/u/.local/share/wsl-web-shell\ndsh=/home/u/.local/share/wsl-web-shell/runtime/bin/dsh\n')).toEqual({
      dshPath: '/home/u/.local/share/wsl-web-shell/runtime/bin/dsh',
      nodePath: null,
      rootPath: '/home/u/.local/share/wsl-web-shell',
    });
  });
});

describe('supervisor isolation wiring', () => {
  it('prepares the environment and launches with isolation by default', async () => {
    const harness = createHarness();
    const supervisor = new Supervisor(harness.deps);

    await supervisor.start();

    expect(supervisor.state).toBe('READY');
    expect(harness.wsl.runtimeQueries).toEqual([{ isolationRoot: ROOT, override: null }]);
    expect(harness.wsl.isolationPreparations).toEqual([ROOT]);
    expect(harness.wsl.starts[0]).toMatchObject({
      isolationRoot: ROOT,
      nodePath: '/usr/bin/node',
      workspace: `${ROOT}/workspace`,
    });
    expect(harness.registry.read()).toMatchObject({ workspace: `${ROOT}/workspace` });
  });

  it('keeps an explicitly configured workspace and dsh override', async () => {
    const harness = createHarness({
      config: { workspace: '~/projects/app', dshPath: '/opt/wsl-web-shell/runtime/bin/dsh' },
    });
    const supervisor = new Supervisor(harness.deps);

    await supervisor.start();

    expect(harness.wsl.runtimeQueries[0]).toEqual({ isolationRoot: ROOT, override: '/opt/wsl-web-shell/runtime/bin/dsh' });
    expect(harness.wsl.starts[0]).toMatchObject({
      workspace: '~/projects/app',
      dshPath: '/opt/wsl-web-shell/runtime/bin/dsh',
      isolationRoot: ROOT,
    });
  });

  it('honours a custom isolation root', async () => {
    const harness = createHarness({ config: { runtimeRoot: '~/r02/sandbox' } });
    const supervisor = new Supervisor(harness.deps);

    await supervisor.start();

    expect(harness.wsl.isolationPreparations).toEqual(['~/r02/sandbox']);
    expect(harness.wsl.starts[0]).toMatchObject({
      isolationRoot: '~/r02/sandbox',
      workspace: '~/r02/sandbox/workspace',
    });
  });

  it('launches without isolation when the owner disables it', async () => {
    const harness = createHarness({ config: { isolateEnvironment: false } });
    const supervisor = new Supervisor(harness.deps);

    await supervisor.start();

    expect(harness.wsl.isolationPreparations).toEqual([]);
    expect(harness.wsl.runtimeQueries[0]).toEqual({ isolationRoot: null, override: null });
    expect(harness.wsl.starts[0]).toMatchObject({ isolationRoot: ISOLATION_DISABLED, workspace: '~' });
  });

  it('fails closed when the isolated environment cannot be created', async () => {
    const harness = createHarness({ wsl: { failPrepare: true } });
    const supervisor = new Supervisor(harness.deps);

    await expect(supervisor.start()).rejects.toBeTruthy();

    expect(supervisor.state).toBe('ERROR');
    expect(harness.wsl.starts).toHaveLength(0);
    expect(lastStatus(harness.statuses).ownedServer).toBe(false);
  });

  it('never starts the backend when dsh is missing inside the isolated runtime', async () => {
    const harness = createHarness({ wsl: { failResolve: 'dsh-missing' } });
    const supervisor = new Supervisor(harness.deps);

    await expect(supervisor.start()).rejects.toBeTruthy();

    expect(supervisor.state).toBe('ERROR');
    expect(harness.wsl.starts).toHaveLength(0);
  });
});

describe('isolation configuration', () => {
  it('is enabled by default under the documented root', () => {
    expect(DEFAULT_CONFIG.isolateEnvironment).toBe(true);
    expect(DEFAULT_CONFIG.runtimeRoot).toBe(ISOLATION_ROOT_DEFAULT);
  });

  it('normalizes persisted values and rejects unsafe roots', () => {
    for (const stored of ['/', '~', '~/x', '/srv/a;b', '~/a/../b']) {
      const normalized = normalizeConfig({ isolateEnvironment: true, runtimeRoot: stored });
      expect(normalized.runtimeRoot).toBe(ISOLATION_ROOT_DEFAULT);
    }
    const off = normalizeConfig({ isolateEnvironment: false, runtimeRoot: '/srv/sandbox/wsl-web-shell' });
    expect(off.isolateEnvironment).toBe(false);
    expect(off.runtimeRoot).toBe('/srv/sandbox/wsl-web-shell');
  });

  it('validates patches field by field', () => {
    const bad = applyConfigPatch(DEFAULT_CONFIG, { isolateEnvironment: 'no' as unknown as boolean, runtimeRoot: '/srv' });
    expect(bad.errors).toContain('isolateEnvironment: expected a boolean');
    expect(bad.errors).toContain('runtimeRoot: expected a dedicated POSIX path such as ~/.local/share/wsl-web-shell');
    expect(bad.changed).toBe(false);

    const good = applyConfigPatch(DEFAULT_CONFIG, { runtimeRoot: '~/sandbox/app', isolateEnvironment: true });
    expect(good.errors).toEqual([]);
    expect(good.config.runtimeRoot).toBe('~/sandbox/app');
    expect(good.changed).toBe(true);
  });

  it('requires a backend restart when the environment changes', () => {
    const next = applyConfigPatch(DEFAULT_CONFIG, { runtimeRoot: '~/other/app' }).config;
    expect(requiresRestart(DEFAULT_CONFIG, next)).toBe(true);
    expect(requiresRestart(DEFAULT_CONFIG, applyConfigPatch(DEFAULT_CONFIG, { openOnLaunch: false }).config)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Real script execution inside a disposable sandbox                          */
/* -------------------------------------------------------------------------- */

const shellAvailable = process.platform !== 'win32' && existsSync('/bin/bash') && existsSync('/bin/sh');
const isRootUser = typeof process.getuid === 'function' && process.getuid() === 0;

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), 'wss-sbx-'));
}

/** Run a launcher script exactly as `wsl.exe --exec /bin/bash -c` would. */
function runScript(script: string, args: string[], home: string, cwd = home) {
  return spawnSync('/bin/bash', ['-c', script, ...args], {
    encoding: 'utf8',
    cwd,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home },
  });
}

function writeStub(path: string, body: string): string {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

describe.skipIf(!shellAvailable)('launcher scripts execute as designed', () => {
  it('parses without syntax errors', () => {
    for (const script of [START_WRAPPER_SCRIPT, PREPARE_ISOLATION_SCRIPT, RESOLVE_RUNTIME_SCRIPT]) {
      const check = spawnSync('/bin/bash', ['-n', '-c', script], { encoding: 'utf8' });
      expect(check.stderr).toBe('');
      expect(check.status).toBe(0);
    }
  });

  it('creates exactly the planned tree inside the sandbox home', () => {
    const home = sandbox();
    try {
      const result = runScript(PREPARE_ISOLATION_SCRIPT, [SCRIPT_ARGV0, ROOT], home);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const root = join(home, '.local/share/wsl-web-shell');
      expect(result.stdout.trim()).toBe(root);
      expect(readdirSync(root).sort()).toEqual(['agents', 'cache', 'dsh-home', 'runtime', 'tmp', 'workspace']);
      expect(readdirSync(join(root, 'runtime'))).toEqual(['bin']);
      expect(statSync(root).mode & 0o777).toBe(0o700);
      expect(statSync(join(root, 'dsh-home')).mode & 0o777).toBe(0o700);
      // Nothing outside the root was created.
      expect(readdirSync(home)).toEqual(['.local']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('honours a custom absolute root inside the sandbox', () => {
    const home = sandbox();
    try {
      const root = join(home, 'custom/app-root');
      const result = runScript(PREPARE_ISOLATION_SCRIPT, [SCRIPT_ARGV0, root], home);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(root);
      expect(existsSync(join(root, 'dsh-home'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('preserves pre-existing content and never removes anything', () => {
    const home = sandbox();
    try {
      const root = join(home, '.local/share/wsl-web-shell');
      mkdirSync(join(root, 'dsh-home'), { recursive: true });
      writeFileSync(join(root, 'dsh-home', 'keep.yaml'), 'user data\n');
      writeFileSync(join(root, 'notes.txt'), 'notes\n');

      const result = runScript(PREPARE_ISOLATION_SCRIPT, [SCRIPT_ARGV0, ROOT], home);
      expect(result.status).toBe(0);
      expect(readFileSync(join(root, 'dsh-home', 'keep.yaml'), 'utf8')).toBe('user data\n');
      expect(readFileSync(join(root, 'notes.txt'), 'utf8')).toBe('notes\n');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects root-like, traversal and malformed roots without writing anything', () => {
    const cases: { root: string; code: number }[] = [
      { root: '/', code: 66 },
      { root: '~', code: 66 },
      { root: '~/', code: 66 },
      { root: '~/x', code: 66 },
      { root: 'relative/root', code: 64 },
      { root: '/srv/bad root', code: 64 },
      { root: '/srv/a;rm -rf /', code: 64 },
      { root: '~/.local/../secret', code: 66 },
      { root: '/srv/./app', code: 66 },
      { root: '/srv//app', code: 66 },
    ];
    for (const testCase of cases) {
      const home = sandbox();
      try {
        const result = runScript(PREPARE_ISOLATION_SCRIPT, [SCRIPT_ARGV0, testCase.root], home);
        expect(result.status, `root=${testCase.root}`).toBe(testCase.code);
        expect(readdirSync(home), `root=${testCase.root}`).toEqual([]);
        if (!isRootUser) {
          // The filesystem-level guard never runs: nothing was created outside.
          expect(existsSync('/runtime')).toBe(false);
          expect(existsSync('/dsh-home')).toBe(false);
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  });

  it('refuses a symlinked isolation root', () => {
    const home = sandbox();
    try {
      const outside = join(home, 'outside');
      mkdirSync(outside);
      const root = join(home, '.local/share/wsl-web-shell');
      mkdirSync(join(home, '.local/share'), { recursive: true });
      symlinkSync(outside, root);

      const result = runScript(PREPARE_ISOLATION_SCRIPT, [SCRIPT_ARGV0, ROOT], home);
      expect(result.status).toBe(67);
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses a symlink anywhere between the home and the root', () => {
    const home = sandbox();
    try {
      const outside = join(home, 'outside');
      mkdirSync(outside);
      mkdirSync(join(home, '.local'));
      symlinkSync(outside, join(home, '.local/share'));

      const result = runScript(PREPARE_ISOLATION_SCRIPT, [SCRIPT_ARGV0, ROOT], home);
      expect(result.status).toBe(67);
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses a symlinked managed subdirectory instead of writing through it', () => {
    for (const managed of ['agents', 'dsh-home', 'cache', 'tmp', 'workspace', 'runtime']) {
      const home = sandbox();
      try {
        const outside = join(home, 'outside');
        mkdirSync(outside);
        const root = join(home, '.local/share/wsl-web-shell');
        mkdirSync(root, { recursive: true });
        symlinkSync(outside, join(root, managed));

        const result = runScript(PREPARE_ISOLATION_SCRIPT, [SCRIPT_ARGV0, ROOT], home);
        expect(result.status, `managed=${managed}`).toBe(67);
        expect(readdirSync(outside), `managed=${managed}`).toEqual([]);
        // Other managed directories are still absent: the run stopped early.
        expect(existsSync(join(root, 'workspace'))).toBe(managed === 'workspace');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  });

  it('delivers the isolated environment and the working directory to the backend', () => {
    const home = sandbox();
    try {
      expect(runScript(PREPARE_ISOLATION_SCRIPT, [SCRIPT_ARGV0, ROOT], home).status).toBe(0);
      const project = join(home, 'projects/demo');
      mkdirSync(project, { recursive: true });

      const stub = writeStub(
        join(home, 'dsh-stub'),
        [
          '#!/bin/sh',
          'printf "PWD=%s\\n" "$PWD"',
          'printf "DSH_HOME=%s\\n" "$DSH_HOME"',
          'printf "DSH_AGENTS_HOME=%s\\n" "$DSH_AGENTS_HOME"',
          'printf "XDG_CACHE_HOME=%s\\n" "$XDG_CACHE_HOME"',
          'printf "TMPDIR=%s\\n" "$TMPDIR"',
          'printf "ISOLATION_ROOT=%s\\n" "$WSL_WEB_SHELL_ISOLATION_ROOT"',
          'printf "PATH=%s\\n" "$PATH"',
          'printf "ARGS=%s\\n" "$*"',
        ].join('\n'),
      );

      const result = runScript(
        START_WRAPPER_SCRIPT,
        [stub, '127.0.0.1', '3080', ROOT, '/usr/bin/node', '~/projects/demo'],
        home,
      );
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);

      const root = join(home, '.local/share/wsl-web-shell');
      const lines = result.stdout.trim().split('\n');
      expect(lines[0]).toContain('__dsh_web_shell_pid__');
      const env = Object.fromEntries(lines.slice(1).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
      expect(env.PWD).toBe(project);
      expect(env.DSH_HOME).toBe(join(root, 'dsh-home'));
      expect(env.DSH_AGENTS_HOME).toBe(join(root, 'agents'));
      expect(env.XDG_CACHE_HOME).toBe(join(root, 'cache'));
      expect(env.TMPDIR).toBe(join(root, 'tmp'));
      expect(env.ISOLATION_ROOT).toBe(root);
      expect(env.PATH?.startsWith(`${join(root, 'runtime/bin')}:/usr/bin:`)).toBe(true);
      expect(env.ARGS).toBe('web --host 127.0.0.1 --port 3080 --no-open');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('enters the isolated workspace when the configured workspace is ~', () => {
    const home = sandbox();
    try {
      expect(runScript(PREPARE_ISOLATION_SCRIPT, [SCRIPT_ARGV0, ROOT], home).status).toBe(0);
      const stub = writeStub(join(home, 'dsh-stub'), '#!/bin/sh\npwd\n');
      const result = runScript(START_WRAPPER_SCRIPT, [stub, '127.0.0.1', '3080', ROOT, '-', '~'], home);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(join(home, '.local/share/wsl-web-shell/workspace'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses to start in a missing or non-directory workspace', () => {
    const home = sandbox();
    try {
      expect(runScript(PREPARE_ISOLATION_SCRIPT, [SCRIPT_ARGV0, ROOT], home).status).toBe(0);
      const marker = join(home, 'backend-started');
      const stub = writeStub(join(home, 'dsh-stub'), `#!/bin/sh\n: > "${marker}"\n`);

      const missing = runScript(START_WRAPPER_SCRIPT, [stub, '127.0.0.1', '3080', ROOT, '-', '~/nope'], home);
      expect(missing.status).toBe(65);
      expect(missing.stderr).toContain('workspace directory not found');
      expect(existsSync(marker)).toBe(false);

      writeFileSync(join(home, 'afile'), 'x');
      const notDir = runScript(START_WRAPPER_SCRIPT, [stub, '127.0.0.1', '3080', ROOT, '-', '~/afile'], home);
      expect(notDir.status).toBe(65);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses a malformed workspace argument', () => {
    const home = sandbox();
    try {
      const stub = writeStub(join(home, 'dsh-stub'), '#!/bin/sh\nexit 0\n');
      const result = runScript(START_WRAPPER_SCRIPT, [stub, '127.0.0.1', '3080', ISOLATION_DISABLED, '-', 'relative/dir'], home);
      expect(result.status).toBe(64);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses to launch when the isolated environment is missing or a symlink', () => {
    const home = sandbox();
    try {
      const stub = writeStub(join(home, 'dsh-stub'), '#!/bin/sh\nexit 0\n');

      const missing = runScript(START_WRAPPER_SCRIPT, [stub, '127.0.0.1', '3080', ROOT, '-', '~'], home);
      expect(missing.status).toBe(67);

      expect(runScript(PREPARE_ISOLATION_SCRIPT, [SCRIPT_ARGV0, ROOT], home).status).toBe(0);
      const root = join(home, '.local/share/wsl-web-shell');
      rmSync(join(root, 'agents'), { recursive: true, force: true });
      const outside = join(home, 'outside');
      mkdirSync(outside);
      symlinkSync(outside, join(root, 'agents'));

      const linked = runScript(START_WRAPPER_SCRIPT, [stub, '127.0.0.1', '3080', ROOT, '-', '~'], home);
      expect(linked.status).toBe(67);
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects an unsafe isolation root before starting the backend', () => {
    const home = sandbox();
    try {
      const marker = join(home, 'backend-started');
      const stub = writeStub(join(home, 'dsh-stub'), `#!/bin/sh\n: > "${marker}"\n`);
      for (const [root, code] of [
        ['/', 66],
        ['~', 66],
        ['~/x', 66],
        ['/srv/../etc', 66],
        ['relative', 64],
      ] as [string, number][]) {
        const result = runScript(START_WRAPPER_SCRIPT, [stub, '127.0.0.1', '3080', root, '-', '~'], home);
        expect(result.status, `root=${root}`).toBe(code);
      }
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('leaves the environment untouched when isolation is disabled', () => {
    const home = sandbox();
    try {
      const stub = writeStub(
        join(home, 'dsh-stub'),
        '#!/bin/sh\nprintf "DSH_HOME=%s|ROOT=%s|PWD=%s\\n" "${DSH_HOME:-unset}" "${WSL_WEB_SHELL_ISOLATION_ROOT:-unset}" "$PWD"',
      );
      const result = runScript(START_WRAPPER_SCRIPT, [stub, '127.0.0.1', '3080', ISOLATION_DISABLED, '-', '~'], home);
      expect(result.status).toBe(0);
      const line = result.stdout.trim().split('\n')[1] ?? '';
      expect(line).toContain('DSH_HOME=unset');
      expect(line).toContain('ROOT=unset');
      expect(line).toContain(`PWD=${home}`);
      expect(line).not.toContain('wsl-web-shell/dsh-home');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('resolves the isolated dsh before any system install', () => {
    const home = sandbox();
    try {
      const root = join(home, '.local/share/wsl-web-shell');
      const isolatedDsh = join(root, 'runtime/bin/dsh');
      const systemDsh = join(home, '.local/bin/dsh');
      mkdirSync(join(root, 'runtime/bin'), { recursive: true });
      mkdirSync(join(home, '.local/bin'), { recursive: true });
      writeStub(isolatedDsh, '#!/bin/sh\nexit 0\n');
      writeStub(systemDsh, '#!/bin/sh\nexit 0\n');

      const result = runScript(RESOLVE_RUNTIME_SCRIPT, [SCRIPT_ARGV0, ROOT], home);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`dsh=${isolatedDsh}`);
      // The probe never modifies the filesystem.
      expect(readdirSync(join(home, '.local/bin'))).toEqual(['dsh']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!shellAvailable)('single-argument scripts receive their parameter', () => {
  it('reads the probe argument from $1, not from $0', () => {
    const argv = buildProbeProcessArgs('Ubuntu', process.pid);
    const tail = argv.slice(argv.indexOf(PROBE_PROCESS_SCRIPT) + 1);
    expect(tail).toEqual([SCRIPT_ARGV0, String(process.pid)]);
    const result = spawnSync('/bin/sh', ['-c', PROBE_PROCESS_SCRIPT, ...tail], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    const probe = parseProcessProbe(result.stdout);
    expect(probe?.startTime).toMatch(/^\d+$/);
    expect(probe?.cmdline.trim().length).toBeGreaterThan(0);
  });
});
