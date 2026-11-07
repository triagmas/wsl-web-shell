/**
 * Issue #12 — one-click update: guards, terminal buffer, phase model, journal
 * recovery, relaunch decision and the runner transaction.
 *
 * Nothing here spawns WSL or npm: every decision is driven through injected
 * fakes, so all safety rules can be asserted without touching an installation.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  UPDATE_REASONS,
  UPDATE_TERMINAL_MAX_LINES,
  createTransactionId,
  createUpdateState,
  createUpdateTerminal,
  decideRecovery,
  describeUpdatePhase,
  describeUpdateReason,
  isExactVersion,
  isExpectedRuntimePath,
  isSameVersion,
  isUpdateCritical,
  isUpdateRunning,
  isValidTransactionId,
  parseUpdateJournal,
  phaseFromUpdateLine,
  planTerminalUpdate,
  planUpdate,
  sanitizeUpdateLine,
  shouldRestartAfterUpdate,
  type RuntimeObservation,
  type UpdateJournal,
  type UpdateJournalStore,
} from '../src/main/core/update.js';
import { createUpdateRunner } from '../src/main/core/update-runner.js';
import { recoverInterruptedUpdate } from '../src/main/core/update-recovery.js';
import { describeRelaunchFailure, resolveRelaunchTarget } from '../src/main/core/relaunch.js';
import { createNullLogger } from '../src/main/core/logger.js';
import type { NpmVersionCheck, UpdateRunResult, UpdateTransition, WslGateway } from '../src/main/core/supervisor.js';

const ROOT = '~/.local/share/wsl-web-shell';
const CANONICAL = '/home/u/.local/share/wsl-web-shell';
const RUNTIME_DSH = `${CANONICAL}/runtime/bin/dsh`;

function plan(overrides: Partial<Parameters<typeof planUpdate>[0]> = {}) {
  return planUpdate({
    distro: 'Ubuntu',
    targetVersion: '0.2.2-rc.1',
    installedVersion: '0.2.1-rc.5',
    resolvedDshPath: RUNTIME_DSH,
    canonicalRuntimeRoot: CANONICAL,
    isolationEnabled: true,
    runtimeRoot: ROOT,
    customExecutable: false,
    ...overrides,
  });
}

describe('exact version guard', () => {
  it('accepts plain and pre-release versions', () => {
    expect(isExactVersion('0.2.2')).toBe(true);
    expect(isExactVersion('0.2.2-rc.1')).toBe(true);
    expect(isExactVersion('1.0.0-beta.10')).toBe(true);
  });

  it('rejects ranges, tags and anything a shell could interpret', () => {
    for (const value of ['^0.2.2', '~0.2.2', '>=0.2.2', 'latest', '*', '0.2', '0.2.2 ', '0.2.2; rm -rf /', '0.2.2$(id)', 'v0.2.2', '']) {
      expect(isExactVersion(value), value).toBe(false);
    }
    expect(isExactVersion(undefined)).toBe(false);
    expect(isExactVersion('1'.repeat(60))).toBe(false);
  });

  it('never treats a longer version as the shorter one', () => {
    // `0.2.2-rc.1` must not be satisfied by `0.2.2-rc.10` (the substring bug).
    expect(isSameVersion('0.2.2-rc.1', '0.2.2-rc.10')).toBe(false);
    expect(isSameVersion('0.2.2-rc.1', '0.2.2-rc.1')).toBe(true);
    expect(isSameVersion('v0.2.2', '0.2.2')).toBe(true);
    expect(isSameVersion('0.2.2', '0.2.2.1')).toBe(false);
    expect(isSameVersion(null, '0.2.2')).toBe(false);
    expect(isSameVersion('garbage', '0.2.2')).toBe(false);
  });
});

describe('terminal buffer', () => {
  it('strips escapes and control characters', () => {
    expect(sanitizeUpdateLine('\u001B[32mupdate: ok\u001B[0m')).toBe('update: ok');
    expect(sanitizeUpdateLine('a\rb\u0007c')).toBe('abc');
  });

  it('drops empty lines', () => {
    expect(sanitizeUpdateLine('   ')).toBeNull();
    expect(sanitizeUpdateLine('\u001B[0m')).toBeNull();
    expect(sanitizeUpdateLine('')).toBeNull();
  });

  it('caps very long output lines', () => {
    const line = sanitizeUpdateLine('x'.repeat(5000));
    expect(line).not.toBeNull();
    expect(line?.length).toBeLessThanOrEqual(320);
    expect(line?.endsWith('…')).toBe(true);
  });

  it('keeps a bounded number of lines and counts what it dropped', () => {
    const terminal = createUpdateTerminal(3);
    for (let index = 0; index < 10; index += 1) terminal.append(`line ${index}`);
    expect(terminal.lines()).toEqual(['line 7', 'line 8', 'line 9']);
    expect(terminal.dropped()).toBe(7);
  });

  it('uses the documented default bound', () => {
    const terminal = createUpdateTerminal();
    for (let index = 0; index < UPDATE_TERMINAL_MAX_LINES + 5; index += 1) terminal.append(`line ${index}`);
    expect(terminal.lines()).toHaveLength(UPDATE_TERMINAL_MAX_LINES);
    expect(terminal.dropped()).toBe(5);
  });
});

describe('terminal streaming beyond the rolling cap (review blocker D)', () => {
  it('keeps appending while the buffer still grows', () => {
    const state = { lines: ['a', 'b'], dropped: 0 };
    const next = planTerminalUpdate({ lines: ['a', 'b', 'c'], dropped: 0 }, { dropped: 0, rendered: 2 });
    expect(next.rebuild).toBe(false);
    expect(next.append).toEqual(['c']);
    expect(next.rendered).toBe(3);
    void state;
  });

  it('asks for a redraw once lines were dropped', () => {
    const lines = Array.from({ length: 400 }, (_, index) => `line ${index + 1}`);
    const next = planTerminalUpdate({ lines, dropped: 1 }, { dropped: 0, rendered: 400 });
    expect(next.rebuild).toBe(true);
    expect(next.append).toHaveLength(400);
    expect(next.rendered).toBe(400);
  });

  it('keeps showing new lines after 400+ published lines', () => {
    // Reproduces the freeze: with a fixed `rendered === lines.length`, every
    // later state appended nothing. The offset makes the stream continue.
    const terminal = createUpdateTerminal(400);
    let seen = { dropped: 0, rendered: 0 };
    let buffer = { lines: [] as string[], dropped: 0 };
    for (let index = 1; index <= 450; index += 1) {
      terminal.append(`line ${index}`);
      buffer = { lines: terminal.lines(), dropped: terminal.dropped() };
      const step = planTerminalUpdate(buffer, seen);
      seen = { dropped: buffer.dropped, rendered: step.rendered };
    }
    expect(buffer.dropped).toBe(50);
    expect(buffer.lines[buffer.lines.length - 1]).toBe('line 450');
    expect(seen.rendered).toBe(400);
    // A further line still produces work for the renderer.
    terminal.append('line 451');
    const next = planTerminalUpdate({ lines: terminal.lines(), dropped: terminal.dropped() }, seen);
    expect(next.rebuild || next.append.length > 0).toBe(true);
  });
});

describe('runtime ownership (review blocker C)', () => {
  it('accepts only the exact canonical runtime executable', () => {
    expect(isExpectedRuntimePath(RUNTIME_DSH, CANONICAL)).toBe(true);
    expect(isExpectedRuntimePath('/usr/local/bin/dsh', CANONICAL)).toBe(false);
    expect(isExpectedRuntimePath(`${CANONICAL}/runtime/bin/dsh-other`, CANONICAL)).toBe(false);
    expect(isExpectedRuntimePath(`${CANONICAL}/runtime/bin/npm`, CANONICAL)).toBe(false);
    expect(isExpectedRuntimePath(`${CANONICAL}/runtime-other/bin/dsh`, CANONICAL)).toBe(false);
    // Another user's home that merely contains the same suffix is not ours.
    expect(isExpectedRuntimePath('/home/other/.local/share/wsl-web-shell/runtime/bin/dsh', CANONICAL)).toBe(false);
    expect(isExpectedRuntimePath('/srv/copy/home/u/.local/share/wsl-web-shell/runtime/bin/dsh', CANONICAL)).toBe(false);
  });

  it('refuses unnormalised or missing paths', () => {
    expect(isExpectedRuntimePath(null, CANONICAL)).toBe(false);
    expect(isExpectedRuntimePath(RUNTIME_DSH, null)).toBe(false);
    expect(isExpectedRuntimePath(`${CANONICAL}/runtime//bin/dsh`, CANONICAL)).toBe(false);
    expect(isExpectedRuntimePath(`${CANONICAL}/runtime/../runtime/bin/dsh`, CANONICAL)).toBe(false);
    expect(isExpectedRuntimePath(RUNTIME_DSH, 'relative/root')).toBe(false);
  });
});

describe('update plan guards', () => {
  it('accepts the isolated runtime of the selected distribution', () => {
    const result = plan();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.version).toBe('0.2.2-rc.1');
    expect(result.plan.canonicalRoot).toBe(CANONICAL);
    expect(result.plan.runtimeDir).toBe(`${CANONICAL}/runtime`);
    expect(result.plan.previousPattern).toContain('previous-');
  });

  it('refuses a global installation', () => {
    expect(plan({ isolationEnabled: false })).toEqual({ ok: false, reason: UPDATE_REASONS.globalInstallation });
  });

  it('refuses a custom executable pinned in Settings', () => {
    expect(plan({ customExecutable: true })).toEqual({ ok: false, reason: UPDATE_REASONS.customExecutable });
  });

  it('refuses a root that is not a dedicated subtree', () => {
    expect(plan({ runtimeRoot: '~' })).toEqual({ ok: false, reason: UPDATE_REASONS.unsafeRoot });
    expect(plan({ runtimeRoot: '/' })).toEqual({ ok: false, reason: UPDATE_REASONS.unsafeRoot });
  });

  it('refuses when WSL did not report a canonical root', () => {
    expect(plan({ canonicalRuntimeRoot: null })).toEqual({ ok: false, reason: UPDATE_REASONS.unsafeRoot });
    expect(plan({ canonicalRuntimeRoot: '~/.local/share/wsl-web-shell' })).toEqual({
      ok: false,
      reason: UPDATE_REASONS.unsafeRoot,
    });
  });

  it('refuses when the executable in use is not the isolated one', () => {
    expect(plan({ resolvedDshPath: '/usr/local/bin/dsh' })).toEqual({
      ok: false,
      reason: UPDATE_REASONS.foreignRuntime,
    });
    expect(plan({ resolvedDshPath: `${CANONICAL}/runtime/bin/dsh.tmp` })).toEqual({
      ok: false,
      reason: UPDATE_REASONS.foreignRuntime,
    });
    expect(plan({ resolvedDshPath: '/home/other/.local/share/wsl-web-shell/runtime/bin/dsh' })).toEqual({
      ok: false,
      reason: UPDATE_REASONS.foreignRuntime,
    });
    expect(plan({ resolvedDshPath: null })).toEqual({ ok: false, reason: UPDATE_REASONS.foreignRuntime });
  });

  it('refuses an unknown installed version', () => {
    expect(plan({ installedVersion: null })).toEqual({ ok: false, reason: UPDATE_REASONS.unknownInstalled });
    expect(plan({ installedVersion: 'dev' })).toEqual({ ok: false, reason: UPDATE_REASONS.unknownInstalled });
  });

  it('refuses the same or an older version', () => {
    expect(plan({ targetVersion: '0.2.1-rc.5' })).toEqual({ ok: false, reason: UPDATE_REASONS.sameOrOlder });
    expect(plan({ targetVersion: '0.2.0' })).toEqual({ ok: false, reason: UPDATE_REASONS.sameOrOlder });
  });

  it('refuses a version that is not an exact release', () => {
    expect(plan({ targetVersion: '^0.2.2' })).toEqual({ ok: false, reason: UPDATE_REASONS.invalidVersion });
  });

  it('explains every refusal in the confirmation window', () => {
    for (const reason of Object.values(UPDATE_REASONS)) {
      expect(describeUpdateReason(reason).length).toBeGreaterThan(20);
    }
  });
});

describe('phase model', () => {
  it('reports running phases', () => {
    expect(isUpdateRunning('checking')).toBe(true);
    expect(isUpdateRunning('stopping')).toBe(true);
    expect(isUpdateRunning('starting')).toBe(true);
    expect(isUpdateRunning('done')).toBe(false);
    expect(isUpdateRunning('failed')).toBe(false);
    expect(isUpdateRunning('rolled-back')).toBe(false);
  });

  it('refuses to quit only while the runtime is being replaced', () => {
    for (const phase of ['stopping', 'activating', 'starting'] as const) expect(isUpdateCritical(phase)).toBe(true);
    for (const phase of ['idle', 'checking', 'installing', 'verifying', 'done', 'failed', 'rolled-back'] as const) {
      expect(isUpdateCritical(phase)).toBe(false);
    }
  });

  it('only relaunches after a completed update', () => {
    expect(shouldRestartAfterUpdate('done')).toBe(true);
    for (const phase of ['idle', 'checking', 'installing', 'verifying', 'stopping', 'activating', 'starting', 'failed', 'rolled-back'] as const) {
      expect(shouldRestartAfterUpdate(phase)).toBe(false);
    }
  });

  it('follows the updater step markers', () => {
    expect(phaseFromUpdateLine('update: verifying the staged installation')).toBe('verifying');
    expect(phaseFromUpdateLine('update: activating')).toBe('activating');
    expect(phaseFromUpdateLine('update: done')).toBeNull();
    expect(describeUpdatePhase('failed')).toContain('failed');
    expect(describeUpdatePhase('rolled-back')).toContain('restored');
  });
});

// --- transaction journal and recovery --------------------------------------

const journal = (overrides: Partial<UpdateJournal> = {}): UpdateJournal => ({
  version: 1,
  transaction: '20261107T101500Z-1a2b',
  phase: 'activating',
  distro: 'Ubuntu',
  runtimeRoot: ROOT,
  canonicalRoot: CANONICAL,
  target: '0.2.2-rc.1',
  installed: '0.2.1-rc.5',
  startedAt: '2026-11-07T10:15:00.000Z',
  updatedAt: '2026-11-07T10:15:04.000Z',
  ...overrides,
});

const observation = (overrides: Partial<RuntimeObservation> = {}): RuntimeObservation => ({
  runtimePresent: true,
  runtimeVersion: '0.2.1-rc.5',
  previous: null,
  stage: null,
  ...overrides,
});

describe('transaction journal', () => {
  it('creates ids that are safe as a path segment and as argv', () => {
    const id = createTransactionId(new Date('2026-11-07T10:15:00.000Z'));
    expect(isValidTransactionId(id)).toBe(true);
    expect(id.startsWith('20261107T101500Z')).toBe(true);
    expect(id.includes('.')).toBe(false);
    for (const bad of ['', 'short', '../escape', 'a b', "x'; rm -rf /", 'a'.repeat(64)]) {
      expect(isValidTransactionId(bad), bad).toBe(false);
    }
  });

  it('round-trips a valid journal', () => {
    expect(parseUpdateJournal(journal())).toEqual(journal());
  });

  it('refuses a journal it cannot trust', () => {
    expect(parseUpdateJournal(null)).toBeNull();
    expect(parseUpdateJournal({})).toBeNull();
    expect(parseUpdateJournal({ ...journal(), version: 2 })).toBeNull();
    expect(parseUpdateJournal({ ...journal(), phase: 'swapped' })).toBeNull();
    expect(parseUpdateJournal({ ...journal(), transaction: '../x' })).toBeNull();
    expect(parseUpdateJournal({ ...journal(), target: '^0.2.2' })).toBeNull();
    expect(parseUpdateJournal({ ...journal(), canonicalRoot: 'relative' })).toBeNull();
  });
});

describe('interrupted update recovery (review blocker B)', () => {
  it('finalizes when the new runtime is already active', () => {
    expect(decideRecovery(journal(), observation({ runtimeVersion: '0.2.2-rc.1', previous: 'previous-20261107T101500Z-1a2b' }))).toEqual({
      action: 'finalize',
      reason: 'the activated runtime already reports 0.2.2-rc.1',
    });
  });

  it('abandons a journal whose update never replaced the runtime', () => {
    // Quit during staging: the runtime still reports the pre-update version.
    const decision = decideRecovery(journal({ installed: '0.2.1-rc.5' }), observation({ previous: null }));
    expect(decision.action).toBe('abandon');
    expect(decision.reason).toContain('never replaced');
  });

  it('rolls back when the runtime reports an unexpected version', () => {
    const decision = decideRecovery(journal(), observation({ runtimeVersion: '0.2.0', previous: 'previous-x' }));
    expect(decision.action).toBe('rollback');
  });

  it('rolls back when the runtime is missing but the previous copy survives', () => {
    const decision = decideRecovery(journal(), observation({ runtimePresent: false, runtimeVersion: null, previous: 'previous-x' }));
    expect(decision.action).toBe('rollback');
    expect(decision.reason).toContain('previous-x');
  });

  it('rolls back to the staged tree when nothing else is left', () => {
    const decision = decideRecovery(
      journal(),
      observation({ runtimePresent: false, runtimeVersion: null, previous: null, stage: 'stage-x' }),
    );
    expect(decision.action).toBe('rollback');
  });

  it('blocks instead of starting an unknown runtime', () => {
    const decision = decideRecovery(journal(), observation({ runtimePresent: false, runtimeVersion: null }));
    expect(decision.action).toBe('blocked');
  });

  it('does not accept a longer version as the target', () => {
    const decision = decideRecovery(
      journal(),
      observation({ runtimeVersion: '0.2.2-rc.10', previous: 'previous-x' }),
    );
    expect(decision.action).toBe('rollback');
  });
});

function memoryJournal(initial: UpdateJournal | null): UpdateJournalStore & { current: () => UpdateJournal | null } {
  let current = initial;
  return {
    read: () => current,
    write: (next) => {
      current = next;
    },
    clear: () => {
      current = null;
    },
    current: () => current,
  };
}

describe('recovery orchestration', () => {
  const baseDeps = () => {
    const calls: string[] = [];
    return {
      calls,
      wsl: {
        async inspectRuntime() {
          calls.push('inspect');
          return observation({ runtimePresent: false, runtimeVersion: null, previous: 'previous-x' });
        },
        async restoreRuntime() {
          calls.push('restore');
          return { code: 0, tail: 'update: rollout reverted' } as UpdateRunResult;
        },
      },
      resume: async (): Promise<UpdateTransition> => {
        calls.push('resume');
        return { ok: true, message: null };
      },
      log: createNullLogger(),
    };
  };

  it('does nothing without a journal', async () => {
    const store = memoryJournal(null);
    const result = await recoverInterruptedUpdate({ ...baseDeps(), wsl: new FakeInspect(), journal: store });
    expect(result).toEqual({ handled: false, action: null, message: null });
    expect(store.current()).toBeNull();
  });

  it('abandons a staging-only journal without touching the runtime', async () => {
    const calls: string[] = [];
    const store = memoryJournal(journal({ phase: 'staging' }));
    const result = await recoverInterruptedUpdate({
      wsl: {
        inspectRuntime: async () => {
          calls.push('inspect');
          return observation({ runtimeVersion: '0.2.1-rc.5' });
        },
        restoreRuntime: async () => {
          calls.push('restore');
          return { code: 0, tail: '' };
        },
      },
      journal: store,
      resume: async () => {
        calls.push('resume');
        return { ok: true, message: null };
      },
      log: createNullLogger(),
    });
    expect(result.action).toBe('abandon');
    expect(calls).toEqual(['inspect', 'resume']);
    expect(store.current()).toBeNull();
  });

  it('clears the journal after a successful repair', async () => {
    const deps = baseDeps();
    const store = memoryJournal(journal());
    const result = await recoverInterruptedUpdate({ ...deps, journal: store });
    expect(result.action).toBe('rollback');
    expect(deps.calls).toEqual(['inspect', 'restore', 'resume']);
    expect(store.current()).toBeNull();
  });

  it('keeps the journal when finalize cannot start the new version (P0-B)', async () => {
    // The swap completed, but the new runtime does not serve: the journal must
    // survive so the next start can still roll back.
    const store = memoryJournal(journal({ phase: 'verifying-backend' }));
    const calls: string[] = [];
    const result = await recoverInterruptedUpdate({
      wsl: {
        inspectRuntime: async () =>
          observation({ runtimeVersion: '0.2.2-rc.1', previous: 'previous-x' }),
        restoreRuntime: async () => {
          calls.push('restore');
          return { code: 74, tail: 'update: nothing to restore' };
        },
      },
      journal: store,
      resume: async () => {
        calls.push('resume');
        return { ok: false, message: 'auth-failed: 401' };
      },
      log: createNullLogger(),
    });
    expect(result.action).toBe('blocked');
    expect(calls).toEqual(['resume', 'restore']);
    expect(store.current()).not.toBeNull();
    expect(result.message).toContain('journal was kept');
  });

  it('rolls back a finalize whose new version does not start', async () => {
    const store = memoryJournal(journal({ phase: 'verifying-backend' }));
    let resumes = 0;
    const result = await recoverInterruptedUpdate({
      wsl: {
        inspectRuntime: async () => observation({ runtimeVersion: '0.2.2-rc.1', previous: 'previous-x' }),
        restoreRuntime: async () => ({ code: 0, tail: 'update: rollout reverted' }),
      },
      journal: store,
      resume: async () => {
        resumes += 1;
        return resumes === 1 ? { ok: false, message: 'auth-failed: 401' } : { ok: true, message: null };
      },
      log: createNullLogger(),
    });
    expect(result.action).toBe('rollback');
    expect(result.message).toContain('previous installation was restored');
    expect(store.current()).toBeNull();
  });

  it('keeps the journal when the restored backend does not start, and retries on the next start', async () => {
    const store = memoryJournal(journal());
    const failing = await recoverInterruptedUpdate({
      wsl: {
        inspectRuntime: async () =>
          observation({ runtimePresent: false, runtimeVersion: null, previous: 'previous-x' }),
        restoreRuntime: async () => ({ code: 0, tail: 'update: rollout reverted' }),
      },
      journal: store,
      resume: async () => ({ ok: false, message: 'backend-lost: nothing listening' }),
      log: createNullLogger(),
    });
    expect(failing.action).toBe('blocked');
    expect(store.current()).not.toBeNull();

    // A second start still has the record and repairs it once the backend works.
    const repaired = await recoverInterruptedUpdate({
      wsl: {
        inspectRuntime: async () =>
          observation({ runtimePresent: false, runtimeVersion: null, previous: 'previous-x' }),
        restoreRuntime: async () => ({ code: 0, tail: 'update: rollout reverted' }),
      },
      journal: store,
      resume: async () => ({ ok: true, message: null }),
      log: createNullLogger(),
    });
    expect(repaired.action).toBe('rollback');
    expect(store.current()).toBeNull();
  });

  it('keeps the journal when the restore fails, so the next start retries', async () => {
    const deps = baseDeps();
    const store = memoryJournal(journal());
    const result = await recoverInterruptedUpdate({
      ...deps,
      wsl: {
        inspectRuntime: deps.wsl.inspectRuntime,
        restoreRuntime: async () => ({ code: 74, tail: 'update: nothing to restore' }),
      },
      journal: store,
    });
    expect(result.action).toBe('blocked');
    expect(store.current()).not.toBeNull();
  });
});

/** Inspect fake returning "runtime missing, previous present". */
class FakeInspect {
  async inspectRuntime(): Promise<RuntimeObservation> {
    return observation({ runtimePresent: false, runtimeVersion: null, previous: 'previous-x' });
  }
  async restoreRuntime(): Promise<UpdateRunResult> {
    return { code: 0, tail: 'update: rollout reverted' };
  }
}

// --- runner ----------------------------------------------------------------

interface Harness {
  wsl: Pick<WslGateway, 'checkPublishedVersion' | 'stageRuntime' | 'activateRuntime' | 'restoreRuntime'>;
  lifecycle: {
    pauseForUpdate(): Promise<UpdateTransition>;
    resumeAfterUpdate(): Promise<UpdateTransition>;
    releaseUpdateLock(): void;
    blockForRuntime(message: string): void;
    updateInProgress: boolean;
  };
  blocked: string[];
  journal: UpdateJournalStore & { current(): UpdateJournal | null };
  published: string[];
  lines: string[];
  order: string[];
  paused: number;
  resumed: number;
  checks: number;
  stages: number;
  activates: number;
  restores: number;
}

function harness(
  options: {
    check?: Partial<NpmVersionCheck>;
    stage?: UpdateRunResult;
    activate?: UpdateRunResult;
    restore?: UpdateRunResult;
    pause?: UpdateTransition;
    resume?: UpdateTransition[];
    pauseThrows?: boolean;
    journalWriteError?: string;
    journalPhases?: string[];
  } = {},
): Harness {
  const state: Harness = {
    published: [],
    lines: [],
    order: [],
    paused: 0,
    resumed: 0,
    checks: 0,
    stages: 0,
    activates: 0,
    restores: 0,
    journal: memoryJournal(null),
    blocked: [],
    lifecycle: {
      updateInProgress: false,
      blockForRuntime(message: string) {
        state.blocked.push(message);
        state.order.push('block');
      },
      async pauseForUpdate() {
        state.paused += 1;
        state.order.push('pause');
        if (options.pauseThrows === true) throw new Error('stop failed');
        return options.pause ?? { ok: true, message: null };
      },
      async resumeAfterUpdate() {
        state.resumed += 1;
        state.order.push('resume');
        const queue = options.resume ?? [{ ok: true, message: null }];
        return queue[Math.min(state.resumed - 1, queue.length - 1)] ?? { ok: true, message: null };
      },
      releaseUpdateLock() {
        state.order.push('release');
      },
    },
    wsl: {
      async checkPublishedVersion() {
        state.checks += 1;
        state.order.push('check');
        return { found: true, npmPath: '/usr/bin/npm', reported: '0.2.2-rc.1', message: null, ...options.check };
      },
      async stageRuntime(_request, onLine) {
        state.stages += 1;
        state.order.push('stage');
        for (const line of ['update: verifying the staged installation', 'update: staged version 0.2.2-rc.1']) {
          state.lines.push(line);
          onLine(line);
        }
        return options.stage ?? { code: 0, tail: 'update: staged version 0.2.2-rc.1' };
      },
      async activateRuntime(_request, onLine) {
        state.activates += 1;
        state.order.push('activate');
        onLine('update: activating');
        onLine('update: installed version 0.2.2-rc.1');
        return options.activate ?? { code: 0, tail: 'update: installed version 0.2.2-rc.1' };
      },
      async restoreRuntime(_request, onLine) {
        state.restores += 1;
        state.order.push('restore');
        onLine('update: restoring the previous installation');
        return options.restore ?? { code: 0, tail: 'update: rollout reverted' };
      },
    },
  };
  return state;
}

function runner(h: Harness) {
  return createUpdateRunner({
    wsl: h.wsl,
    lifecycle: h.lifecycle,
    journal: h.journal,
    log: createNullLogger(),
    publish: (state) => h.published.push(state.phase),
    now: () => '2026-11-01T00:00:00.000Z',
  });
}

const context = { distro: 'Ubuntu', nodePath: '/home/u/.local/bin/node', transaction: '20261107T101500Z-1a2b' };

describe('update runner transaction', () => {
  const accepted = plan();
  if (!accepted.ok) throw new Error('plan must be accepted');

  it('stages, stops the owned backend, activates, starts and only then reports done', async () => {
    const h = harness();
    const outcome = await runner(h).run(accepted.plan, context);
    expect(outcome.ok).toBe(true);
    // Exact order: nothing is swapped before the backend was stopped.
    expect(h.order).toEqual(['check', 'stage', 'pause', 'activate', 'resume']);
    expect(h.journal.current()).toBeNull();
    const transitions = h.published.filter((phase, index) => phase !== h.published[index - 1]);
    expect(transitions).toEqual(['checking', 'installing', 'verifying', 'stopping', 'activating', 'starting', 'done']);
    expect(outcome.state.detail).toContain('previous-');
  });

  it('never installs when npm does not know the version', async () => {
    const h = harness({ check: { found: false, message: 'npm did not report this version.' } });
    const outcome = await runner(h).run(accepted.plan, context);
    expect(outcome.ok).toBe(false);
    expect(h.stages).toBe(0);
    expect(h.order).toEqual(['check']);
    expect(outcome.state.detail).toContain('npm did not report');
  });

  it('stops before activation when npm is missing', async () => {
    const h = harness({ check: { found: false, npmPath: null, message: 'npm was not found in this distribution.' } });
    const outcome = await runner(h).run(accepted.plan, context);
    expect(outcome.ok).toBe(false);
    expect(h.stages).toBe(0);
    expect(h.paused).toBe(0);
  });

  it('does not touch the runtime when the staged install fails', async () => {
    const h = harness({ stage: { code: 71, tail: 'update: staged version check failed' } });
    const outcome = await runner(h).run(accepted.plan, context);
    expect(outcome.ok).toBe(false);
    expect(h.paused).toBe(0);
    expect(h.activates).toBe(0);
    expect(h.restores).toBe(0);
    expect(h.journal.current()).toBeNull();
    expect(outcome.state.detail).toContain('staged version check failed');
  });

  it('keeps the running backend when it cannot be stopped', async () => {
    const h = harness({ pause: { ok: false, message: 'The app-owned backend could not be stopped: denied' } });
    const outcome = await runner(h).run(accepted.plan, context);
    expect(outcome.ok).toBe(false);
    expect(h.activates).toBe(0);
    expect(outcome.state.detail).toContain('could not be stopped');
  });

  it('restores the previous install and restarts it when activation fails', async () => {
    const h = harness({ activate: { code: 73, tail: 'update: activation failed, restoring the previous install' } });
    const outcome = await runner(h).run(accepted.plan, context);
    expect(outcome.ok).toBe(false);
    expect(h.restores).toBe(1);
    expect(h.order.slice(-2)).toEqual(['restore', 'resume']);
    expect(outcome.state.phase).toBe('rolled-back');
    expect(outcome.state.detail).toContain('was restored and the previous version is running again');
    expect(h.journal.current()).toBeNull();
  });

  it('rolls back when the new version does not start', async () => {
    const h = harness({ resume: [{ ok: false, message: 'auth-failed: 401' }, { ok: true, message: null }] });
    const outcome = await runner(h).run(accepted.plan, context);
    expect(outcome.ok).toBe(false);
    expect(h.restores).toBe(1);
    expect(h.resumed).toBe(2);
    expect(outcome.state.phase).toBe('rolled-back');
    expect(outcome.state.detail).toContain('previous version is running again');
    expect(h.journal.current()).toBeNull();
  });

  it('writes the journal before the swap and removes it after success', async () => {
    const writes: string[] = [];
    const h = harness();
    h.journal = {
      read: () => null,
      write: (entry) => {
        writes.push(entry.phase);
      },
      clear: () => {
        writes.push('clear');
      },
      current: () => null,
    };
    const outcome = await runner(h).run(accepted.plan, context);
    expect(outcome.ok).toBe(true);
    expect(writes).toEqual(['staging', 'activating', 'verifying-backend', 'clear']);
  });

  it('leaves a recoverable journal when the process dies during the swap', async () => {
    const writes: string[] = [];
    const h = harness();
    h.journal = {
      read: () => null,
      write: (entry) => {
        writes.push(entry.phase);
      },
      clear: () => {
        writes.push('clear');
      },
      current: () => null,
    };
    h.wsl.activateRuntime = async () => {
      // Simulate the app being killed between the two renames.
      throw Object.assign(new Error('process gone'), { name: 'ProcessGone' });
    };
    const outcome = await runner(h).run(accepted.plan, context);
    expect(outcome.ok).toBe(false);
    expect(writes).toContain('activating');
    // The journal write happened before activation, so the next start can repair.
    expect(writes.indexOf('activating')).toBeLessThan(writes.length);
  });

  it('refuses to install anything when the staging journal cannot be written (P0-A)', async () => {
    const h = harness();
    const cleared: string[] = [];
    h.journal = {
      read: () => null,
      write: () => {
        throw new Error('EACCES: permission denied, open update-journal.json');
      },
      clear: () => {
        cleared.push('clear');
      },
      current: () => null,
    };
    const outcome = await runner(h).run(accepted.plan, context);
    expect(outcome.ok).toBe(false);
    expect(outcome.state.phase).toBe('failed');
    expect(outcome.state.detail).toContain('journal could not be written');
    expect(outcome.state.detail).toContain('nothing was installed');
    // Nothing ran inside WSL: no npm install, no stop, no swap.
    expect(h.stages).toBe(0);
    expect(h.paused).toBe(0);
    expect(h.activates).toBe(0);
    expect(cleared).toEqual([]);
  });

  it('does not stop or swap the runtime when the activating journal cannot be written (P0-A)', async () => {
    let writes = 0;
    const cleared: string[] = [];
    const h = harness();
    h.journal = {
      read: () => null,
      write: () => {
        writes += 1;
        // The staging record is written, the activating one fails: exactly the
        // window the runtime must not be touched in.
        if (writes > 1) throw new Error('ENOSPC: no space left on device');
      },
      clear: () => {
        cleared.push('clear');
      },
      current: () => null,
    };
    const outcome = await runner(h).run(accepted.plan, context);
    expect(outcome.ok).toBe(false);
    // The stage is prepared but the backend keeps running and nothing is swapped.
    expect(h.stages).toBe(1);
    expect(h.paused).toBe(0);
    expect(h.activates).toBe(0);
    expect(outcome.state.detail).toContain('nothing was replaced');
  });

  it('keeps the journal and blocks the app when the rollback itself fails (P0-B)', async () => {
    const h = harness({
      activate: { code: 73, tail: 'update: activation failed, restoring the previous install' },
      restore: { code: 74, tail: 'update: nothing to restore' },
    });
    const outcome = await runner(h).run(accepted.plan, { ...context });
    // Activation fails, the previous install cannot be restored.
    expect(outcome.ok).toBe(false);
    expect(h.restores).toBe(1);
    expect(h.blocked).toHaveLength(1);
    expect(outcome.state.phase).toBe('failed');
    expect(outcome.state.detail).toContain('could not be restored');
    expect(outcome.state.detail).toContain('journal was kept');
    // The record survives and the old backend is not claimed to be running.
    expect(h.journal.current()).not.toBeNull();
    expect(h.resumed).toBe(0);
  });

  it('keeps the journal when the restored backend does not start (P0-B)', async () => {
    const h = harness({ resume: [{ ok: false, message: 'backend-lost: nothing listening' }] });
    const outcome = await runner(h).run(accepted.plan, context);
    expect(outcome.ok).toBe(false);
    expect(h.restores).toBe(1);
    expect(h.blocked).toHaveLength(1);
    expect(outcome.state.phase).toBe('failed');
    expect(outcome.state.detail).toContain('journal was kept');
    expect(h.journal.current()).not.toBeNull();
  });

  it('keeps the journal after a failed restore in the exception path', async () => {
    const h = harness({ restore: { code: 74, tail: 'update: nothing to restore' } });
    h.wsl.activateRuntime = async () => {
      throw Object.assign(new Error('process gone'), { name: 'ProcessGone' });
    };
    const outcome = await runner(h).run(accepted.plan, context);
    expect(outcome.ok).toBe(false);
    expect(h.blocked).toHaveLength(1);
    expect(h.journal.current()).not.toBeNull();
  });

  it('releases the update lock when the backend cannot be stopped (P1-C)', async () => {
    const h = harness({ pause: { ok: false, message: 'The app-owned backend could not be stopped: denied' } });
    const outcome = await runner(h).run(accepted.plan, context);
    expect(outcome.ok).toBe(false);
    expect(outcome.state.detail).toContain('could not be stopped');
    expect(h.order).toContain('release');
    expect(h.activates).toBe(0);
    expect(h.journal.current()).toBeNull();
  });

  it('releases the update lock when stopping the backend throws (P1-C)', async () => {
    const h = harness({ pauseThrows: true });
    const outcome = await runner(h).run(accepted.plan, context);
    expect(outcome.ok).toBe(false);
    expect(outcome.state.phase).toBe('failed');
    expect(h.order).toContain('release');
    expect(h.activates).toBe(0);
    expect(h.journal.current()).toBeNull();
  });

  it('does not run twice at the same time', async () => {
    const h = harness();
    const runnerInstance = runner(h);
    const first = runnerInstance.run(accepted.plan, context);
    const second = await runnerInstance.run(accepted.plan, context);
    expect(second.ok).toBe(false);
    await expect(first).resolves.toBeTruthy();
    expect(h.stages).toBe(1);
  });

  it('turns a thrown gateway error into a failed state', async () => {
    const h = harness();
    h.wsl.stageRuntime = async () => {
      throw new Error('wsl.exe is missing');
    };
    const outcome = await runner(h).run(accepted.plan, context);
    expect(outcome.ok).toBe(false);
    expect(outcome.state.phase).toBe('failed');
    expect(outcome.state.detail).toContain('wsl.exe is missing');
  });

  it('starts from a clean state', () => {
    const state = createUpdateState('2026-01-01T00:00:00.000Z');
    expect(state.phase).toBe('idle');
    expect(state.lines).toEqual([]);
    expect(state.dropped).toBe(0);
    expect(state.targetVersion).toBeNull();
  });
});

describe('portable relaunch (review blocker D)', () => {
  const portable = 'D:\\Apps\\WSL-Web-Shell-0.1.0-x64.exe';

  it('relaunches the portable executable, not the extraction copy', () => {
    const decision = resolveRelaunchTarget(
      { portableExecutableFile: portable, execPath: 'C:\\Temp\\2abc\\WSL Web Shell.exe', platform: 'win32' },
      (path) => path === portable,
    );
    expect(decision).toEqual({ ok: true, target: { execPath: portable, portable: true } });
  });

  it('refuses to guess when the app was not started from the portable EXE', () => {
    expect(resolveRelaunchTarget({ portableExecutableFile: null, execPath: 'C:\\dev\\electron.exe', platform: 'win32' })).toEqual({
      ok: false,
      reason: 'portable-missing',
    });
    expect(
      resolveRelaunchTarget({ portableExecutableFile: 'C:\\gone\\app.exe', execPath: 'C:\\dev\\electron.exe', platform: 'win32' }, () => false),
    ).toEqual({ ok: false, reason: 'portable-not-a-file' });
    expect(
      resolveRelaunchTarget({ portableExecutableFile: 'C:\\temp\\x.txt', execPath: 'C:\\dev\\electron.exe', platform: 'win32' }, () => true),
    ).toEqual({ ok: false, reason: 'portable-not-a-file' });
  });

  it('explains every refused relaunch to the user', () => {
    for (const reason of ['portable-missing', 'portable-not-a-file', 'not-windows'] as const) {
      expect(describeRelaunchFailure(reason).length).toBeGreaterThan(40);
    }
  });
});

// --- wiring invariants -----------------------------------------------------

const root = join(import.meta.dirname, '..');
const read = (relative: string): string => readFileSync(join(root, relative), 'utf8');

describe('update window and shutdown wiring (review blocker D)', () => {
  const windowsSource = read('src/main/electron/windows.ts');
  const indexSource = read('src/main/index.ts');
  const progressSource = read('src/update/progress.js');

  it('keeps the terminal window unclosable while the run is active', () => {
    expect(windowsSource).toContain('setClosable(false)');
    expect(windowsSource).toContain('setClosable(!running)');
    expect(windowsSource).toContain("window.on('close', (event) => {");
    expect(windowsSource).toContain('event.preventDefault()');
    expect(windowsSource).toContain('isUpdateRunning(');
  });

  it('refuses to quit while the runtime is being replaced', () => {
    expect(indexSource).toContain('quit refused: the update is');
    expect(indexSource).toContain('isUpdateCritical(');
    // Quitting during staging stays possible, and is logged as an abandoned stage.
    expect(indexSource).toContain('quit during update staging');
  });

  it('rebuilds the terminal once the rolling cap starts dropping lines', () => {
    expect(progressSource).toContain('state.dropped');
    expect(progressSource).toContain('writeLines(lines)');
    expect(progressSource).toContain('lines.slice(rendered)');
  });

  it('never relaunches an unknown executable', () => {
    expect(indexSource).toContain('resolveRelaunchTarget(');
    expect(indexSource).toContain('describeRelaunchFailure(');
    expect(indexSource).toContain('PORTABLE_EXECUTABLE_FILE');
    // The old unconditional relaunch is gone.
    expect(indexSource).not.toContain('app.relaunch(portable === null ? {}');
  });
});
