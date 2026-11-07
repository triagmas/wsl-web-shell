/**
 * Recovery for an interrupted update (issue #12).
 *
 * The swap replaces `runtime/` with the staged tree in two renames. If the app,
 * the process or Windows dies between them, the next start has to know what
 * happened instead of guessing:
 *
 * - a journal is written to the app profile *before* the swap and removed after
 *   the update really finished (or was rolled back);
 * - on start, the journal plus a read-only inspection of the isolated root decide
 *   between `finalize` (the new runtime is already active and correct),
 *   `rollback` (restore the kept previous installation) and `blocked` (nothing can
 *   be restored safely — the app must not start anything).
 *
 * The decision itself is pure (`decideRecovery` in `update.ts`); this module adds
 * the file-backed journal and the small orchestration around it.
 */
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from './logger.js';
import type { UpdateTransition, WslGateway } from './supervisor.js';
import {
  UpdateJournalError,
  decideRecovery,
  parseUpdateJournal,
  type RuntimeObservation,
  type UpdateJournal,
  type UpdateJournalStore,
} from './update.js';

export interface UpdateRecoveryResult {
  /** True when a journal was found and something was done about it. */
  handled: boolean;
  action: 'finalize' | 'rollback' | 'abandon' | 'blocked' | null;
  message: string | null;
}

function errorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return null;
}

function detailOf(error: unknown): string {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : 'unknown error';
  return code === null ? message : `${code}: ${message}`;
}

/**
 * Journal persisted as JSON in the app profile.
 *
 * `write()` is deliberately fail-loud: the caller must not replace a runtime it
 * cannot repair after a crash. The content is flushed, renamed into place and
 * read back, so a full or read-only profile stops the update instead of leaving
 * a silent gap.
 *
 * `read()` distinguishes the three states a profile can be in: no journal (a
 * normal start), a valid journal (repair it) and a journal that exists but is
 * corrupt or unreadable — that last one throws, because ignoring it would start
 * the backend on a runtime nobody can vouch for.
 */
export function createJournalStore(path: string, log: Logger): UpdateJournalStore {
  return {
    read(): UpdateJournal | null {
      // `existsSync` would answer `false` for a journal behind an unreadable
      // directory, so the entry is checked with lstat and the errno is inspected:
      // only a genuinely missing entry may be read as "no journal".
      try {
        lstatSync(path);
      } catch (error) {
        const code = errorCode(error);
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          // No entry, or a parent that cannot hold one: a normal start.
          log.debug(`update journal absent (${code})`);
          return null;
        }
        // EACCES/EPERM/ELOOP/... — the record may exist and cannot be inspected.
        const detail = detailOf(error);
        log.error(`update journal cannot be inspected: ${detail}`);
        throw new UpdateJournalError('unreadable', path, detail);
      }

      let raw: string;
      try {
        raw = readFileSync(path, 'utf8');
      } catch (error) {
        const code = errorCode(error);
        if (code === 'ENOENT') {
          // The entry is a link whose target is gone: the state is unknown.
          log.error('update journal is a link to a missing file');
          throw new UpdateJournalError('unreadable', path, 'linked file does not exist');
        }
        const detail = detailOf(error);
        log.error(`update journal exists but cannot be read: ${detail}`);
        throw new UpdateJournalError('unreadable', path, detail);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        log.error('update journal exists but is not valid JSON');
        throw new UpdateJournalError('corrupt', path, 'not valid JSON');
      }

      const journal = parseUpdateJournal(parsed);
      if (journal === null) {
        log.error('update journal exists but its content is not a valid record');
        throw new UpdateJournalError('corrupt', path, 'unexpected content');
      }
      return journal;
    },
    write(journal: UpdateJournal): void {
      const directory = dirname(path);
      const temporary = `${path}.tmp`;
      // Errors are not swallowed: the updater must stop before it touches the
      // runtime when its recovery record cannot be stored.
      mkdirSync(directory, { recursive: true });
      const descriptor = openSync(temporary, 'w');
      try {
        writeSync(descriptor, `${JSON.stringify(journal, null, 2)}\n`);
        // Flush the content before the rename: a crash then leaves either the old
        // journal or the new one, never an empty file.
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporary, path);
      try {
        // Best effort: make the rename itself durable. Not supported everywhere.
        const directoryDescriptor = openSync(directory, 'r');
        try {
          fsyncSync(directoryDescriptor);
        } finally {
          closeSync(directoryDescriptor);
        }
      } catch {
        // Directory fsync is unavailable on some platforms; the rename is atomic.
      }
      // Read the record back: only a journal that can be parsed again protects
      // the next start, so a write that produced anything else is a failure.
      const persisted = parseUpdateJournal(JSON.parse(readFileSync(path, 'utf8')) as unknown);
      if (persisted === null || persisted.transaction !== journal.transaction || persisted.phase !== journal.phase) {
        throw new Error('the update journal could not be verified after writing');
      }
      log.info(`update journal written (tx=${journal.transaction}, phase=${journal.phase})`);
    },
    clear(): void {
      try {
        rmSync(path, { force: true });
      } catch (error) {
        log.warn(`update journal could not be removed: ${error instanceof Error ? error.message : 'unknown'}`);
      }
    },
  };
}

export interface UpdateRecoveryDeps {
  wsl: Pick<WslGateway, 'inspectRuntime' | 'restoreRuntime'>;
  journal: UpdateJournalStore;
  /** Start the backend from whatever runtime is active after the repair. */
  resume: () => Promise<UpdateTransition>;
  log: Logger;
}

/**
 * Repair an update that was interrupted after the staging step.
 *
 * Called once at start-up, before the normal backend start: if a journal exists,
 * the isolated root is inspected and either the new runtime is accepted (it is
 * already active and correct) or the previous installation is restored. The
 * backend is then started, so a completed update does not need a second restart
 * and a rollback comes back with a working WebUI.
 */
export async function recoverInterruptedUpdate(deps: UpdateRecoveryDeps): Promise<UpdateRecoveryResult> {
  let journal: UpdateJournal | null;
  try {
    journal = deps.journal.read();
  } catch (error) {
    // The file exists but cannot be trusted. Keep it (it is the only evidence of
    // what may have happened) and refuse to start DeepSeek Harness.
    const message =
      error instanceof UpdateJournalError
        ? `${error.message}. DeepSeek Harness was not started: repair or remove that file to continue.`
        : `The update journal could not be read (${error instanceof Error ? error.message : 'unknown error'}). DeepSeek Harness was not started.`;
    deps.log.error(`update recovery: ${message}`);
    return { handled: true, action: 'blocked', message };
  }
  if (journal === null) return { handled: false, action: null, message: null };

  deps.log.warn(
    `update recovery: journal found (tx=${journal.transaction}, phase=${journal.phase}, target=${journal.target})`,
  );

  let observation: RuntimeObservation;
  try {
    observation = await deps.wsl.inspectRuntime(journal.distro, journal.runtimeRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    deps.log.error(`update recovery: inspecting the isolated root failed (${message})`);
    // Keep the journal: the state is unknown, so the next start retries.
    return {
      handled: true,
      action: 'blocked',
      message: `The state of the last update could not be inspected: ${message}`,
    };
  }

  const decision = decideRecovery(journal, observation);
  deps.log.info(`update recovery: ${decision.action} (${decision.reason})`);

  if (decision.action === 'abandon') {
    // Only staging happened: the runtime was never replaced, so there is nothing
    // to undo. The staged tree stays for a later attempt and is reused by name.
    deps.journal.clear();
    const resumed = await deps.resume();
    return {
      handled: true,
      action: 'abandon',
      message: resumed.ok ? null : (resumed.message ?? 'The backend did not start.'),
    };
  }

  if (decision.action === 'finalize') {
    const resumed = await deps.resume();
    if (resumed.ok) {
      // Proven: the new runtime is active and serves the WebUI.
      deps.journal.clear();
      return { handled: true, action: 'finalize', message: null };
    }
    // The new runtime is in place but does not serve: restore the previous one and
    // keep the journal until that is proven as well.
    deps.log.warn(`update recovery: the updated version did not start (${resumed.message ?? 'unknown'})`);
    const fallback = await deps.wsl
      .restoreRuntime(
        {
          distro: journal.distro,
          isolationRoot: journal.runtimeRoot,
          transaction: journal.transaction,
          nodePath: null,
        },
        (line) => deps.log.info(`update recovery: ${line}`),
      )
      .catch((error: unknown) => ({ code: null, tail: error instanceof Error ? error.message : 'unknown' }));
    if (fallback.code !== 0) {
      return {
        handled: true,
        action: 'blocked',
        message: `The updated version did not start (${resumed.message ?? 'unknown error'}) and the previous installation could not be restored (${fallback.tail}). The journal was kept.`,
      };
    }
    const recovered = await deps.resume();
    if (!recovered.ok) {
      return {
        handled: true,
        action: 'blocked',
        message: `The previous installation was restored, but its backend did not start (${recovered.message ?? 'unknown error'}). The journal was kept.`,
      };
    }
    deps.journal.clear();
    return {
      handled: true,
      action: 'rollback',
      message: `The updated version did not start (${resumed.message ?? 'unknown error'}); the previous installation was restored and is running again.`,
    };
  }

  if (decision.action === 'rollback') {
    const restored = await deps.wsl
      .restoreRuntime(
        {
          distro: journal.distro,
          isolationRoot: journal.runtimeRoot,
          transaction: journal.transaction,
          nodePath: null,
        },
        (line) => deps.log.info(`update recovery: ${line}`),
      )
      .catch((error: unknown) => ({ code: null, tail: error instanceof Error ? error.message : 'unknown' }));
    if (restored.code !== 0) {
      // Keep the journal so a later start can try again, and do not start a
      // backend whose runtime may be the half-swapped tree.
      return {
        handled: true,
        action: 'blocked',
        message: `The previous installation could not be restored: ${restored.tail}`,
      };
    }
    const resumed = await deps.resume();
    if (!resumed.ok) {
      // Keep the record: the next start must be able to try again.
      return {
        handled: true,
        action: 'blocked',
        message: `The previous installation was restored, but its backend did not start (${resumed.message ?? 'unknown error'}). The journal was kept.`,
      };
    }
    deps.journal.clear();
    return { handled: true, action: 'rollback', message: null };
  }

  return {
    handled: true,
    action: 'blocked',
    message: `An interrupted update left no usable runtime: ${decision.reason}. Reinstall DeepSeek Harness into the isolated runtime, or restore it from ${journal.canonicalRoot}/update.`,
  };
}
