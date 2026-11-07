/**
 * One-click DeepSeek Harness update (issue #12).
 *
 * Everything here is pure: version guards, the ownership checks that decide
 * whether an update is allowed at all, the bounded terminal buffer that the
 * modal window renders, the phase model the UI follows and the transaction
 * journal that makes an interrupted update recoverable. No Electron, no child
 * processes — `update-runner.ts` drives the WSL scripts with these decisions.
 *
 * Safety model:
 * - only an exact published version is accepted (no ranges, tags or shell text),
 *   and the installed version is compared exactly, never as a substring;
 * - only the isolated runtime below the *canonical* root WSL reported may be
 *   replaced — never a global installation, a custom executable, the official
 *   Windows app or a runtime that merely looks similar;
 * - the previous install is kept next to the root for rollback, and a journal
 *   written to the app profile makes an interrupted swap recoverable on the
 *   next start.
 */
import { redactSecrets } from '../backend/urls.js';
import { isValidIsolationRoot, joinPosix } from './isolation.js';
import { compareSemver, parseSemver } from './versions.js';

/** How many terminal lines the progress window keeps. */
export const UPDATE_TERMINAL_MAX_LINES = 400;
/** Longest single line kept from the updater output. */
export const UPDATE_TERMINAL_MAX_LINE_LENGTH = 320;

/**
 * An exact release version: `0.2.2`, `0.2.2-rc.1`, never a range or a tag.
 * Deliberately strict — the value ends up as an npm install target.
 */
const EXACT_VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,31})?$/;

export function isExactVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 44 && EXACT_VERSION.test(value) && parseSemver(value) !== null;
}

/**
 * Two version strings are the same release.
 *
 * `0.2.2-rc.1` and `0.2.2-rc.10` are different releases, so this is a strict
 * comparison of the normalised strings — not a `startsWith`/substring test.
 */
export function isSameVersion(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return false;
  const a = parseSemver(left.trim().replace(/^v/, ''));
  const b = parseSemver(right.trim().replace(/^v/, ''));
  if (a === null || b === null) return false;
  return compareSemver(left.trim(), right.trim()) === 0;
}

/** Strip ANSI escapes, control characters and carriage returns. */
const ANSI = /\u001B\[[0-9;?]*[A-Za-z]/g;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * One line as the terminal window may show it.
 *
 * Output comes from npm and from user-installed scripts, so it is treated as
 * untrusted text: escapes and control characters are removed, secrets are
 * redacted and the line is capped. `null` means "nothing to show".
 */
export function sanitizeUpdateLine(raw: string): string | null {
  const cleaned = raw.replace(ANSI, '').replace(CONTROL, '').replace(/\r/g, '').trimEnd();
  if (cleaned.trim() === '') return null;
  const redacted = redactSecrets(cleaned);
  return redacted.length > UPDATE_TERMINAL_MAX_LINE_LENGTH
    ? `${redacted.slice(0, UPDATE_TERMINAL_MAX_LINE_LENGTH - 1)}…`
    : redacted;
}

export interface UpdateTerminal {
  /** Append one raw line; returns the sanitized line when it was kept. */
  append(raw: string): string | null;
  lines(): string[];
  /** How many lines were dropped from the front because of the cap. */
  dropped(): number;
  clear(): void;
}

/** Bounded buffer: the terminal window never grows without limit. */
export function createUpdateTerminal(maxLines = UPDATE_TERMINAL_MAX_LINES): UpdateTerminal {
  const kept: string[] = [];
  let dropped = 0;
  return {
    append(raw: string): string | null {
      const line = sanitizeUpdateLine(raw);
      if (line === null) return null;
      kept.push(line);
      if (kept.length > maxLines) {
        const excess = kept.length - maxLines;
        kept.splice(0, excess);
        dropped += excess;
      }
      return line;
    },
    lines: () => [...kept],
    dropped: () => dropped,
    clear: () => {
      kept.length = 0;
      dropped = 0;
    },
  };
}

/**
 * What the terminal window has to do with a newly published state.
 *
 * `dropped` grows as soon as the rolling cap starts discarding lines, so a
 * renderer that only appends would freeze at 400 lines. Comparing the last seen
 * `dropped` with the current one tells it when the whole buffer has to be
 * rebuilt, and everything else can still be appended.
 */
export function planTerminalUpdate(
  state: { lines: string[]; dropped: number },
  seen: { dropped: number; rendered: number },
): { rebuild: boolean; append: string[]; rendered: number } {
  if (state.dropped !== seen.dropped) {
    // The rolling cap discarded lines: the whole buffer has to be redrawn.
    return { rebuild: true, append: [...state.lines], rendered: state.lines.length };
  }
  const append = state.lines.slice(seen.rendered);
  return { rebuild: false, append, rendered: seen.rendered + append.length };
}

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'installing'
  | 'verifying'
  | 'stopping'
  | 'activating'
  | 'starting'
  | 'done'
  | 'failed'
  | 'rolled-back';

const PHASE_TEXT: Record<UpdatePhase, string> = {
  idle: 'Ready',
  checking: 'Checking the published version on npm…',
  installing: 'Installing DeepSeek Harness…',
  verifying: 'Verifying the new installation…',
  stopping: 'Stopping the app-owned backend…',
  activating: 'Activating the new installation…',
  starting: 'Starting DeepSeek Harness…',
  done: 'Update complete',
  failed: 'Update failed',
  'rolled-back': 'Update failed, previous version restored',
};

export function describeUpdatePhase(phase: UpdatePhase): string {
  return PHASE_TEXT[phase];
}

/** True while the process is running and the window must stay open. */
export function isUpdateRunning(phase: UpdatePhase): boolean {
  return (
    phase === 'checking' ||
    phase === 'installing' ||
    phase === 'verifying' ||
    phase === 'stopping' ||
    phase === 'activating' ||
    phase === 'starting'
  );
}

/**
 * Phases during which the app must not quit.
 *
 * Before the swap only a staging directory changes, so a quit is safe and the
 * journal is simply abandoned on the next start. From `stopping` to `starting`
 * `runtime/` is being replaced or started, and interrupting that is exactly what
 * the journal recovery would have to repair — so the app refuses to quit instead.
 */
export function isUpdateCritical(phase: UpdatePhase): boolean {
  return phase === 'stopping' || phase === 'activating' || phase === 'starting';
}

/** The app may only relaunch after a completed update. */
export function shouldRestartAfterUpdate(phase: UpdatePhase): boolean {
  return phase === 'done';
}

/** Reject any path that is not a plain, normalised POSIX absolute path. */
function isNormalisedAbsolute(candidate: string): boolean {
  return (
    candidate.startsWith('/') &&
    !candidate.includes('//') &&
    !candidate.includes('/./') &&
    !candidate.endsWith('/.') &&
    !candidate.includes('/../') &&
    !candidate.endsWith('/..') &&
    candidate !== '/'
  );
}

/**
 * Is the executable in use exactly `<canonicalRoot>/runtime/bin/dsh`?
 *
 * `canonicalRoot` is the absolute, symlink-resolved root that WSL itself
 * reported for the selected distribution and user (`pwd -P`), so this is an
 * exact comparison. A configured `~/…` root is never matched as a substring:
 * another user's home, a similarly named directory or a nested copy is not the
 * runtime this app may replace.
 */
export function isExpectedRuntimePath(resolvedDshPath: string | null, canonicalRoot: string | null): boolean {
  if (resolvedDshPath === null || canonicalRoot === null) return false;
  if (!isNormalisedAbsolute(canonicalRoot) || !isNormalisedAbsolute(resolvedDshPath)) return false;
  const expected = joinPosix(canonicalRoot, 'runtime', 'bin', 'dsh');
  return resolvedDshPath === expected;
}

export interface UpdatePlanInput {
  distro: string;
  /** Exact published version to install. */
  targetVersion: string;
  /** Version of the executable currently in use, `null` when unknown. */
  installedVersion: string | null;
  /** Path the launcher would actually execute inside the distribution. */
  resolvedDshPath: string | null;
  /** Absolute, symlink-resolved root WSL reported, `null` when isolation is off. */
  canonicalRuntimeRoot: string | null;
  /** Isolation must be enabled: a global installation is never replaced. */
  isolationEnabled: boolean;
  /** Configured root of the isolated environment (as written in Settings). */
  runtimeRoot: string;
  /** True when the user pinned a custom executable in Settings. */
  customExecutable: boolean;
}

export interface UpdatePlan {
  distro: string;
  version: string;
  installedVersion: string;
  /** Configured root, used for the script arguments. */
  runtimeRoot: string;
  /** Canonical root reported by WSL, used for ownership and the journal. */
  canonicalRoot: string;
  /** Canonical runtime directory that will be replaced. */
  runtimeDir: string;
  stagingRoot: string;
  /** Filesystem location of the kept previous installation. */
  previousPattern: string;
}

export type UpdatePlanResult = { ok: true; plan: UpdatePlan } | { ok: false; reason: string };

/** Stable reason codes are shown verbatim by the confirmation window. */
export const UPDATE_REASONS = {
  unknownTarget: 'unknown-target',
  invalidVersion: 'invalid-version',
  sameOrOlder: 'not-newer',
  unknownInstalled: 'installed-unknown',
  globalInstallation: 'global-installation',
  customExecutable: 'custom-executable',
  unsafeRoot: 'unsafe-root',
  foreignRuntime: 'foreign-runtime',
} as const;

export function describeUpdateReason(reason: string): string {
  switch (reason) {
    case UPDATE_REASONS.unknownTarget:
      return 'The latest published version is unknown; the GitHub lookup has not completed yet.';
    case UPDATE_REASONS.invalidVersion:
      return 'The published version is not an exact release version, so nothing will be installed.';
    case UPDATE_REASONS.sameOrOlder:
      return 'The published version is not newer than the installed one.';
    case UPDATE_REASONS.unknownInstalled:
      return 'The installed DeepSeek Harness version is unknown; start the backend once and retry.';
    case UPDATE_REASONS.globalInstallation:
      return 'Environment isolation is disabled, so an update would replace a global installation. Enable the isolated environment in Settings first.';
    case UPDATE_REASONS.customExecutable:
      return 'A custom DeepSeek Harness executable is configured in Settings; the app never replaces it.';
    case UPDATE_REASONS.unsafeRoot:
      return 'The isolated runtime root is not a dedicated directory, so it is not updated.';
    case UPDATE_REASONS.foreignRuntime:
      return 'The executable in use is not exactly <root>/runtime/bin/dsh inside the isolated root, so there is nothing safe to replace.';
    default:
      return 'This update cannot be started safely.';
  }
}

/**
 * Decide whether the isolated runtime may be replaced by `targetVersion`.
 *
 * Every rejection is a safety decision, not a failure: the caller shows the
 * reason and stops before running anything inside WSL.
 */
export function planUpdate(input: UpdatePlanInput): UpdatePlanResult {
  if (!isExactVersion(input.targetVersion)) return { ok: false, reason: UPDATE_REASONS.invalidVersion };
  if (!input.isolationEnabled) return { ok: false, reason: UPDATE_REASONS.globalInstallation };
  if (input.customExecutable) return { ok: false, reason: UPDATE_REASONS.customExecutable };
  if (!isValidIsolationRoot(input.runtimeRoot)) return { ok: false, reason: UPDATE_REASONS.unsafeRoot };
  if (input.canonicalRuntimeRoot === null || !isNormalisedAbsolute(input.canonicalRuntimeRoot)) {
    return { ok: false, reason: UPDATE_REASONS.unsafeRoot };
  }
  if (input.installedVersion === null || !isExactVersion(input.installedVersion)) {
    return { ok: false, reason: UPDATE_REASONS.unknownInstalled };
  }
  if (compareSemver(input.targetVersion, input.installedVersion) <= 0) {
    return { ok: false, reason: UPDATE_REASONS.sameOrOlder };
  }
  // The launcher must really be running the copy inside the isolated runtime.
  if (!isExpectedRuntimePath(input.resolvedDshPath, input.canonicalRuntimeRoot)) {
    return { ok: false, reason: UPDATE_REASONS.foreignRuntime };
  }
  return {
    ok: true,
    plan: {
      distro: input.distro,
      version: input.targetVersion,
      installedVersion: input.installedVersion,
      runtimeRoot: input.runtimeRoot,
      canonicalRoot: input.canonicalRuntimeRoot,
      runtimeDir: joinPosix(input.canonicalRuntimeRoot, 'runtime'),
      stagingRoot: joinPosix(input.canonicalRuntimeRoot, 'update'),
      previousPattern: joinPosix(input.canonicalRuntimeRoot, 'update', 'previous-<timestamp>'),
    },
  };
}

export interface UpdateState {
  phase: UpdatePhase;
  /** Version being installed, `null` before a plan exists. */
  targetVersion: string | null;
  installedVersion: string | null;
  /** Short user-facing status, never a secret. */
  message: string;
  /** Actionable detail for a failure (rollback state), `null` while healthy. */
  detail: string | null;
  /** Terminal lines, oldest first, already sanitized. */
  lines: string[];
  /** Lines dropped from the front of `lines` because of the cap. */
  dropped: number;
  updatedAt: string;
}

export function createUpdateState(now: string): UpdateState {
  return {
    phase: 'idle',
    targetVersion: null,
    installedVersion: null,
    message: describeUpdatePhase('idle'),
    detail: null,
    lines: [],
    dropped: 0,
    updatedAt: now,
  };
}

/** Line prefixes the updater script uses to announce its own steps. */
const STEP_MARKERS: { prefix: string; phase: UpdatePhase }[] = [
  { prefix: 'update: verifying', phase: 'verifying' },
  { prefix: 'update: activating', phase: 'activating' },
];

/** Map an updater line to a phase, `null` when the line is plain output. */
export function phaseFromUpdateLine(line: string): UpdatePhase | null {
  for (const marker of STEP_MARKERS) {
    if (line.startsWith(marker.prefix)) return marker.phase;
  }
  return null;
}

// --- transaction journal ---------------------------------------------------

/**
 * Where an update was when the app last looked. Written before the swap, so a
 * crash or a forced quit between the two renames can be repaired on the next
 * start instead of leaving no runtime at all.
 */
export type UpdateJournalPhase = 'staging' | 'activating' | 'verifying-backend';

export interface UpdateJournal {
  version: 1;
  transaction: string;
  phase: UpdateJournalPhase;
  distro: string;
  /** Configured root, so a changed setting is noticed instead of guessed. */
  runtimeRoot: string;
  /** Canonical root the scripts worked in. */
  canonicalRoot: string;
  target: string;
  installed: string;
  startedAt: string;
  updatedAt: string;
}

const JOURNAL_PHASES: UpdateJournalPhase[] = ['staging', 'activating', 'verifying-backend'];
const TRANSACTION_ID = /^[0-9A-Za-z][0-9A-Za-z-]{7,31}$/;

/** A transaction id that is safe both as a path segment and as an argv value. */
export function createTransactionId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const suffix = Math.random().toString(16).slice(2, 6);
  return `${stamp}-${suffix}`.replace(/[^0-9A-Za-z-]/g, '');
}

export function isValidTransactionId(value: unknown): value is string {
  return typeof value === 'string' && TRANSACTION_ID.test(value);
}

/** Validate a journal read back from disk; anything odd means "no journal". */
export function parseUpdateJournal(raw: unknown): UpdateJournal | null {
  if (raw === null || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const fields = ['transaction', 'distro', 'runtimeRoot', 'canonicalRoot', 'target', 'installed', 'startedAt', 'updatedAt'];
  for (const field of fields) {
    if (typeof value[field] !== 'string' || (value[field] as string).length === 0) return null;
  }
  if (value.version !== 1) return null;
  if (!JOURNAL_PHASES.includes(value.phase as UpdateJournalPhase)) return null;
  if (!isValidTransactionId(value.transaction)) return null;
  if (!isExactVersion(value.target) || !isExactVersion(value.installed)) return null;
  if (!isNormalisedAbsolute(value.canonicalRoot as string)) return null;
  return {
    version: 1,
    transaction: value.transaction as string,
    phase: value.phase as UpdateJournalPhase,
    distro: value.distro as string,
    runtimeRoot: value.runtimeRoot as string,
    canonicalRoot: value.canonicalRoot as string,
    target: value.target as string,
    installed: value.installed as string,
    startedAt: value.startedAt as string,
    updatedAt: value.updatedAt as string,
  };
}

/**
 * The journal file exists but cannot be used.
 *
 * A missing file is a normal start; an unreadable or corrupt file is not: the app
 * cannot know whether a swap happened, so it must not start anything.
 */
export class UpdateJournalError extends Error {
  constructor(
    readonly reason: 'corrupt' | 'unreadable',
    readonly path: string,
    detail: string,
  ) {
    super(
      `The update journal at ${path} is ${reason === 'corrupt' ? 'corrupt' : 'unreadable'}${detail === '' ? '' : ` (${detail})`}`,
    );
    this.name = 'UpdateJournalError';
  }
}

/**
 * Persistence for the transaction journal (a file in the app profile).
 *
 * `read()` returns `null` **only** when there is no journal at all. A file that
 * exists but cannot be read or validated throws `UpdateJournalError`: treating
 * that as "nothing happened" would start DeepSeek Harness on top of a runtime
 * whose state is unknown.
 */
export interface UpdateJournalStore {
  read(): UpdateJournal | null;
  write(journal: UpdateJournal): void;
  clear(): void;
}

/** What the distribution currently looks like, as `INSPECT_SCRIPT` reported it. */
export interface RuntimeObservation {
  runtimePresent: boolean;
  /** Version reported by `<root>/runtime/bin/dsh`, `null` when missing. */
  runtimeVersion: string | null;
  /** Directory name of a kept previous installation, `null` when none. */
  previous: string | null;
  /** Directory name of a staged installation, `null` when none. */
  stage: string | null;
}

/**
 * What to do about a journal that outlived its update.
 *
 * - `finalize`: the new runtime is active and reports the target version, so
 *   the update really finished before the app died — keep it.
 * - `abandon`: the runtime still reports the version from before the update
 *   (only staging happened) — nothing to undo, just forget the journal.
 * - `rollback`: the new runtime is missing or wrong while the previous install
 *   is still there — restore it and start the old backend.
 * - `blocked`: nothing can be restored safely; the caller must not start
 *   anything and has to explain the state instead of guessing.
 */
export type RecoveryAction = 'finalize' | 'rollback' | 'abandon' | 'blocked';

export interface RecoveryDecision {
  action: RecoveryAction;
  reason: string;
}

export function decideRecovery(journal: UpdateJournal, observation: RuntimeObservation): RecoveryDecision {
  const sameTarget = isSameVersion(observation.runtimeVersion, journal.target);
  const previousName = observation.previous;

  if (observation.runtimePresent && isSameVersion(observation.runtimeVersion, journal.installed)) {
    return {
      action: 'abandon',
      reason: `the runtime still reports ${journal.installed}, so the update never replaced it`,
    };
  }
  if (observation.runtimePresent && sameTarget) {
    return {
      action: 'finalize',
      reason: `the activated runtime already reports ${journal.target}`,
    };
  }
  if (observation.runtimePresent && !sameTarget && previousName !== null) {
    return {
      action: 'rollback',
      reason: `the active runtime reports ${observation.runtimeVersion ?? 'no version'}, previous installation ${previousName} is available`,
    };
  }
  if (!observation.runtimePresent && previousName !== null) {
    return {
      action: 'rollback',
      reason: `the runtime is missing, previous installation ${previousName} is available`,
    };
  }
  if (!observation.runtimePresent && previousName === null && observation.stage !== null) {
    return {
      action: 'rollback',
      reason: `the runtime is missing and only the staged installation ${observation.stage} exists`,
    };
  }
  return {
    action: 'blocked',
    reason: `the runtime is ${observation.runtimePresent ? `at ${observation.runtimeVersion ?? 'an unknown version'}` : 'missing'} and no previous installation can be restored`,
  };
}
