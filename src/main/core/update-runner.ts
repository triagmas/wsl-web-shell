/**
 * Update runner (issue #12): the only place that sequences an update.
 *
 * Order is fixed and every step is published to the modal window:
 *
 *   checking    npm confirms the exact published version exists
 *   installing  npm installs it into `<root>/update/stage-<tx>` (backend keeps
 *               running: nothing it uses is touched yet)
 *   verifying   the staged executable must report exactly the target version
 *   stopping    auto-recovery is paused and the app-owned backend is stopped
 *   activating  the staged tree replaces `runtime/`, the old tree is kept as
 *               `update/previous-<tx>`, the activated executable is re-checked
 *   starting    a full backend start (runtime resolution, token exchange and the
 *               authenticated request) — success is only claimed after this
 *
 * A journal is written before the swap, so an interruption between the two
 * renames is recoverable on the next start (`update-recovery.ts`). Nothing is
 * retried: a failure restores the previous installation and starts the old
 * backend again.
 *
 * Nothing here decides that an update may happen: `planUpdate()` has already
 * rejected global installations, custom executables, foreign runtimes, unsafe
 * roots and non-exact versions.
 */
import type { Logger } from './logger.js';
import type { UpdateTransition, WslGateway } from './supervisor.js';
import {
  createUpdateState,
  createUpdateTerminal,
  describeUpdatePhase,
  phaseFromUpdateLine,
  type UpdateJournalPhase,
  type UpdateJournalStore,
  type UpdatePlan,
  type UpdateState,
} from './update.js';

/** Minimal supervisor surface the runner needs. */
export interface UpdateLifecycle {
  pauseForUpdate(): Promise<UpdateTransition>;
  resumeAfterUpdate(): Promise<UpdateTransition>;
  releaseUpdateLock(): void;
  /** Terminal state for a runtime that must not be started (failed rollback). */
  blockForRuntime(message: string): void;
  updateInProgress: boolean;
}

export interface UpdateRunnerDeps {
  wsl: Pick<
    WslGateway,
    'checkPublishedVersion' | 'stageRuntime' | 'activateRuntime' | 'restoreRuntime'
  >;
  lifecycle: UpdateLifecycle;
  journal: UpdateJournalStore;
  log: Logger;
  /** Push the current state to every window that renders it. */
  publish: (state: UpdateState) => void;
  now: () => string;
}

export interface UpdateContext {
  distro: string;
  nodePath: string | null;
  transaction: string;
}

export interface UpdateOutcome {
  ok: boolean;
  state: UpdateState;
}

export interface UpdateRunner {
  snapshot(): UpdateState;
  running(): boolean;
  /** Run one accepted plan. Never runs concurrently. */
  run(plan: UpdatePlan, context: UpdateContext): Promise<UpdateOutcome>;
}

export function createUpdateRunner(deps: UpdateRunnerDeps): UpdateRunner {
  const terminal = createUpdateTerminal();
  let state: UpdateState = createUpdateState(deps.now());
  let busy = false;

  const publish = (next: Partial<UpdateState>): UpdateState => {
    state = {
      ...state,
      ...next,
      lines: terminal.lines(),
      dropped: terminal.dropped(),
      updatedAt: deps.now(),
    };
    deps.publish(state);
    return state;
  };

  const append = (line: string): void => {
    const kept = terminal.append(line);
    if (kept === null) return;
    const phase = phaseFromUpdateLine(kept);
    if (phase !== null && phase !== state.phase) {
      // One publish per real transition; repeated markers stay silent.
      publish({ phase, message: describeUpdatePhase(phase) });
      return;
    }
    publish({});
  };

  const fail = (detail: string, phase: UpdateState['phase'] = 'failed'): UpdateState => {
    deps.log.error(`update failed: ${detail}`);
    return publish({ phase, message: describeUpdatePhase(phase), detail });
  };

  /**
   * Persist the journal before the step that needs it.
   *
   * A journal that cannot be written is a hard stop: without it an interruption
   * during the swap would be unrecoverable, so the caller must not continue.
   */
  const writeJournal = (
    plan: UpdatePlan,
    context: UpdateContext,
    phase: UpdateJournalPhase,
    startedAt: string,
  ): boolean => {
    try {
      deps.journal.write({
        version: 1,
        transaction: context.transaction,
        phase,
        distro: plan.distro,
        runtimeRoot: plan.runtimeRoot,
        canonicalRoot: plan.canonicalRoot,
        target: plan.version,
        installed: plan.installedVersion,
        startedAt,
        updatedAt: deps.now(),
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      deps.log.error(`update: the ${phase} journal could not be written: ${message}`);
      terminal.append(`update: the update journal could not be written (${phase}): ${message}`);
      return false;
    }
  };

  /**
   * Remove the journal when the runtime was provably not touched.
   *
   * Used only before the swap: after a swap the journal is the recovery record
   * and is cleared exclusively by a proven success or a proven rollback.
   */
  const clearUnswappedJournal = (): void => {
    deps.journal.clear();
  };

  /**
   * Undo a swap after a failure.
   *
   * The journal is the only record of what happened, so it is removed only when
   * the previous installation was restored *and* the previous backend provably
   * serves the WebUI again. Any other outcome keeps the journal and puts the app
   * into a terminal state: starting from a half-swapped runtime would hide it.
   */
  const rollback = async (
    plan: UpdatePlan,
    context: UpdateContext,
    reason: string,
    where: string,
  ): Promise<UpdateOutcome> => {
    const restored = await deps.wsl
      .restoreRuntime(
        {
          distro: plan.distro,
          isolationRoot: plan.runtimeRoot,
          transaction: context.transaction,
          nodePath: context.nodePath,
        },
        append,
      )
      .catch((error: unknown) => ({
        code: null,
        tail: error instanceof Error ? error.message : 'unknown error',
      }));

    if (restored.code !== 0) {
      const message = `${reason} The previous installation could not be restored (${restored.tail}).`;
      deps.log.error(`update: rollback failed after ${where}; journal kept and further starts blocked`);
      deps.lifecycle.blockForRuntime(message);
      return {
        ok: false,
        state: fail(
          `${message} The app will not start from this runtime: the update journal was kept and the next start tries to restore it again.`,
          'failed',
        ),
      };
    }

    const resumed = await deps.lifecycle.resumeAfterUpdate();
    if (!resumed.ok) {
      const message = `${reason} The previous installation was restored, but its backend did not start (${resumed.message ?? 'unknown error'}).`;
      deps.log.error('update: restart after rollback failed; journal kept and further starts blocked');
      deps.lifecycle.blockForRuntime(message);
      return { ok: false, state: fail(`${message} The update journal was kept.`, 'failed') };
    }

    deps.journal.clear();
    return {
      ok: false,
      state: fail(
        `${reason} The previous installation was restored and the previous version is running again.`,
        'rolled-back',
      ),
    };
  };

  return {
    snapshot: () => state,
    running: () => busy,

    async run(plan: UpdatePlan, context: UpdateContext): Promise<UpdateOutcome> {
      if (busy) return { ok: false, state };
      busy = true;
      terminal.clear();
      state = {
        ...createUpdateState(deps.now()),
        targetVersion: plan.version,
        installedVersion: plan.installedVersion,
      };
      publish({ phase: 'checking', message: describeUpdatePhase('checking'), detail: null });
      deps.log.info(`update: checking ${plan.version} on npm (distro=${plan.distro})`);
      const startedAt = deps.now();
      let activated = false;
      // True from the moment the swap is attempted: if the call itself throws we
      // do not know whether the two renames ran, so the journal must survive.
      let swapStarted = false;

      try {
        const check = await deps.wsl.checkPublishedVersion({
          distro: plan.distro,
          isolationRoot: plan.runtimeRoot,
          version: plan.version,
          nodePath: context.nodePath,
        });
        terminal.append(`update: npm check ${check.found ? 'ok' : 'failed'}`);
        if (check.npmPath !== null) terminal.append(`update: npm ${check.npmPath}`);
        if (!check.found || check.npmPath === null) {
          return {
            ok: false,
            state: fail(check.message ?? 'The published version could not be verified on npm.'),
          };
        }

        // 1. Stage the new version next to the running one. The journal must
        //    exist before anything can be installed or swapped.
        if (!writeJournal(plan, context, 'staging', startedAt)) {
          return {
            ok: false,
            state: fail(
              'The update journal could not be written, so nothing was installed. Check free space and write access of the app profile, then try again.',
            ),
          };
        }
        publish({ phase: 'installing', message: describeUpdatePhase('installing') });
        const request = {
          distro: plan.distro,
          isolationRoot: plan.runtimeRoot,
          version: plan.version,
          nodePath: context.nodePath,
          npmPath: check.npmPath,
          transaction: context.transaction,
        };
        const staged = await deps.wsl.stageRuntime(request, append);
        if (staged.code !== 0) {
          // Nothing was swapped, so the journal can go: the runtime was untouched.
          clearUnswappedJournal();
          const detail =
            staged.tail === '' ? `The updater exited with code ${staged.code ?? 'unknown'}.` : staged.tail;
          return { ok: false, state: fail(detail) };
        }
        terminal.append(`update: ${plan.version} staged and verified`);

        // 2. The activating journal is written *before* the backend is touched: a
        //    journal that cannot be persisted means the swap must not happen.
        if (!writeJournal(plan, context, 'activating', startedAt)) {
          clearUnswappedJournal();
          return {
            ok: false,
            state: fail(
              'The update journal could not be written, so nothing was replaced. Check free space and write access of the app profile, then try again.',
            ),
          };
        }

        // 3. Quiesce: pause recovery, stop only the app-owned backend.
        publish({ phase: 'stopping', message: describeUpdatePhase('stopping') });
        const paused = await deps.lifecycle.pauseForUpdate();
        if (!paused.ok) {
          // Nothing was swapped. Release the lock so the app cannot get stuck and
          // drop the journal, which no longer describes a pending transaction.
          deps.lifecycle.releaseUpdateLock();
          clearUnswappedJournal();
          return {
            ok: false,
            state: fail(paused.message ?? 'The app-owned backend could not be stopped, so nothing was replaced.'),
          };
        }

        // 4. Swap.
        swapStarted = true;
        const swap = await deps.wsl.activateRuntime(request, append);
        activated = swap.code === 0;
        if (!activated) {
          const detail =
            swap.tail === '' ? `Activation failed with code ${swap.code ?? 'unknown'}.` : swap.tail;
          return await rollback(plan, context, detail, 'activation');
        }

        // 5. Prove the new version actually serves the WebUI.
        if (!writeJournal(plan, context, 'verifying-backend', startedAt)) {
          // The previous record still describes the swap, so a crash here stays
          // recoverable: continue instead of throwing the transaction away.
          terminal.append('update: the journal phase could not be updated; the previous record is kept');
        }
        publish({ phase: 'starting', message: describeUpdatePhase('starting') });
        const resumed = await deps.lifecycle.resumeAfterUpdate();
        if (!resumed.ok) {
          terminal.append('update: the new version did not start, restoring the previous installation');
          return await rollback(plan, context, resumed.message ?? 'The new version did not start.', 'start');
        }

        // Only a new backend that really served the WebUI clears the journal.
        deps.journal.clear();
        terminal.append(`update: ${plan.version} is serving the WebUI`);
        const done = publish({
          phase: 'done',
          message: `Updated to ${plan.version}`,
          detail: `Previous installation kept in ${plan.previousPattern} for rollback.`,
        });
        deps.log.info(`update: completed ${plan.installedVersion} -> ${plan.version}`);
        return { ok: true, state: done };
      } catch (error) {
        const detail = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
        if (swapStarted || activated) {
          // The swap may have happened: only a proven rollback may clear the
          // journal, otherwise it stays and the app refuses to start.
          return await rollback(plan, context, detail, 'exception');
        }
        deps.lifecycle.releaseUpdateLock();
        clearUnswappedJournal();
        return { ok: false, state: fail(detail) };
      } finally {
        busy = false;
      }
    },
  };
}
