/**
 * Console update script and result (beta.13).
 *
 * The script is the only thing the app executes, so these tests pin what it may
 * contain: the plan's commands, a log, a start that always runs, and nothing an
 * owner could not read in the window before clicking the button.
 */
import { describe, expect, it } from 'vitest';
import type { DshInstallation } from '../src/main/core/dsh-locate.js';
import { buildManualUpdatePlan } from '../src/main/core/manual-update.js';
import {
  UPDATE_LOG_DIR,
  buildUpdateLogPath,
  buildUpdateResult,
  buildUpdateScript,
  planRunsInConsole,
} from '../src/main/core/update-console.js';

const STAMP = '2026-08-20T10-11-12-345Z';
const LOG = `~/${UPDATE_LOG_DIR}/update-${STAMP}.log`;
const INSTALL = '"/usr/bin/npm" install -g --prefix "/home/triag/.npm-global" @deepseek-ai/dsh@0.2.2';

function installation(overrides: Partial<DshInstallation> = {}): DshInstallation {
  return {
    path: '/home/triag/.npm-global/bin/dsh',
    realPath: '/home/triag/.npm-global/lib/node_modules/@deepseek-ai/dsh/bin/dsh.js',
    symlink: true,
    version: '0.2.1',
    manager: 'npm',
    prefix: '/home/triag/.npm-global',
    packageDir: '/home/triag/.npm-global/lib/node_modules/@deepseek-ai/dsh',
    writable: true,
    npmPath: '/usr/bin/npm',
    source: 'login-shell',
    foreignProcesses: 0,
    foreignPids: [],
    loginShellRealPath: null,
    loginShellVersion: null,
    ...overrides,
  };
}

describe('log path', () => {
  it('builds one path per run from the timestamp', () => {
    expect(buildUpdateLogPath(STAMP)).toBe(LOG);
  });

  it('refuses a timestamp that could escape the directory', () => {
    for (const stamp of ['', '../x', '2026-08-20 10:11:12', '2026-08-20T10:11:12Z;rm -rf /', null]) {
      expect(buildUpdateLogPath(stamp as string)).toBeNull();
    }
  });
});

describe('console script', () => {
  it('echoes, tees and keeps the first failing status', () => {
    const script = buildUpdateScript([INSTALL], LOG);
    expect(script).not.toBeNull();
    expect(script).toContain(`LOG="$HOME/${UPDATE_LOG_DIR}/update-${STAMP}.log"`);
    expect(script).toContain('exec > >(tee -a "$LOG") 2>&1');
    expect(script).toContain(`run '${INSTALL}'`);
    expect(script).toContain('read -r _');
    expect(script).toContain('exit "$fail"');
  });

  it('runs the start line after the unit was stopped, even when the install fails', () => {
    const script = buildUpdateScript(
      ['sudo systemctl stop dsh-web.service', INSTALL, 'sudo systemctl start dsh-web.service'],
      LOG,
    );
    expect(script).not.toBeNull();
    const lines = (script as string).split('\n');
    const stop = lines.findIndex((line) => line.includes('run \'sudo systemctl stop'));
    const install = lines.findIndex((line) => line.includes('@deepseek-ai/dsh@0.2.2'));
    const start = lines.findIndex((line) => line.includes('run \'sudo systemctl start'));
    expect(stop).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(stop);
    expect(start).toBeGreaterThan(install);
    // The install line only runs while nothing has failed yet; the start line is
    // unconditional, so a failed install leaves a running service.
    expect(lines[install]).toContain('if [ "$fail" -eq 0 ]');
    expect(lines[start]).toBe("run 'sudo systemctl start dsh-web.service' || true");
  });

  it('runs a plan with only the install line and no phantom start', () => {
    const script = buildUpdateScript([INSTALL], LOG);
    expect(script).not.toContain('systemctl start');
  });

  it('refuses text the shell would reinterpret', () => {
    expect(buildUpdateScript([], LOG)).toBeNull();
    expect(buildUpdateScript([INSTALL], 'relative.log')).toBeNull();
    expect(buildUpdateScript(["echo 'quoted'"], LOG)).toBeNull();
    expect(buildUpdateScript(['echo one\necho two'], LOG)).toBeNull();
    expect(buildUpdateScript([''], LOG)).toBeNull();
  });
});

describe('console result', () => {
  it('reports success from the version, not the exit code', () => {
    const result = buildUpdateResult({
      code: 1,
      logPath: LOG,
      before: '0.2.1',
      after: '0.2.2',
      target: '0.2.2',
      installation: installation(),
    });
    expect(result.success).toBe(true);
    expect(result.rollbackCommand).toBeNull();
    expect(result.message).toContain('0.2.2');
  });

  it('offers the rollback line when the installation did not move', () => {
    const result = buildUpdateResult({
      code: 1,
      logPath: LOG,
      before: '0.2.1',
      after: '0.2.1',
      target: '0.2.2',
      installation: installation(),
    });
    expect(result.success).toBe(false);
    expect(result.rollbackCommand).toBe(
      '"/usr/bin/npm" install -g --prefix "/home/triag/.npm-global" @deepseek-ai/dsh@0.2.1',
    );
    expect(result.message).toContain('0.2.1');
  });

  it('reports a console that never started, and changes nothing', () => {
    const result = buildUpdateResult({
      code: null,
      logPath: LOG,
      before: '0.2.1',
      after: '0.2.1',
      target: '0.2.2',
      installation: installation(),
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('could not be started');
    expect(result.rollbackCommand).not.toBeNull();
  });

  it('does not claim success when the version cannot be read back', () => {
    const result = buildUpdateResult({
      code: 0,
      logPath: LOG,
      before: '0.2.1',
      after: null,
      target: '0.2.2',
      installation: installation(),
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('could not be read');
    // Nothing is known about the previous version either, so no "go back" line
    // is offered: guessing a version here would be worse than silence.
    expect(result.rollbackCommand).toBe(
      '"/usr/bin/npm" install -g --prefix "/home/triag/.npm-global" @deepseek-ai/dsh@0.2.1',
    );
  });
});

describe('plan gate', () => {
  it('only a pending plan with commands and a console marker runs', () => {
    const pending = buildManualUpdatePlan({
      installation: installation(),
      target: '0.2.2',
      backend: 'none',
      unit: null,
    });
    expect(planRunsInConsole(pending)).toBe(true);
    const attached = buildManualUpdatePlan({
      installation: installation(),
      target: '0.2.2',
      backend: 'attached',
      unit: null,
    });
    expect(planRunsInConsole(attached)).toBe(false);
  });
});
