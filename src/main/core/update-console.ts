/**
 * The console update (beta.13): one linear `bash` script built from the commands
 * the manual update window already shows.
 *
 * Pure module: it builds text and decides what the result means. Spawning the
 * console and waiting for it lives in `src/main/wsl/console.ts`, the app-level
 * orchestration in `src/main/index.ts`.
 *
 * Deliberately not the deleted in-app updater: no snapshots, no journal, no
 * password handling, no rollback automation. The script is short enough to read
 * in the window before the owner clicks the button.
 */
import type { UpdateRunResult } from '../../shared/types.js';
import type { DshInstallation } from './dsh-locate.js';
import type { ManualUpdatePlan } from './manual-update.js';
import { buildInstallCommand } from './manual-update.js';

/** Where the script writes its log, relative to the owner's home in WSL. */
export const UPDATE_LOG_DIR = '.local/share/wsl-web-shell';

/** A timestamp safe to place inside a path and a shell literal. */
const SAFE_STAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z$/;

/** A stop line the script may re-issue: `sudo systemctl stop <unit>`. */
const STOP_LINE = /^(sudo systemctl|systemctl --user) stop [A-Za-z0-9_.@:-]+\.service$/;
/** The matching start line. */
const START_LINE = /^(sudo systemctl|systemctl --user) start [A-Za-z0-9_.@:-]+\.service$/;

/** Log path shown to the owner and used by the script (`$HOME` is expanded there). */
export function buildUpdateLogPath(stamp: string): string | null {
  return SAFE_STAMP.test(stamp) ? `~/${UPDATE_LOG_DIR}/update-${stamp}.log` : null;
}

/**
 * The shell literal for that path.
 *
 * `$HOME` has to stay literal in the script so it resolves inside the
 * distribution, not on Windows.
 */
function logLiteral(logPath: string): string {
  return `"$HOME/${UPDATE_LOG_DIR}/${logPath.split('/').pop() ?? 'update.log'}"`;
}

/**
 * One bash script that runs the plan's command list exactly once.
 *
 * Rules, in order of importance:
 * - each command is echoed before it runs, and everything is teed to the log;
 * - the first failing command decides the exit status, later ones do not run;
 * - when the list is `stop … install … start`, the start line runs on every path
 *   after the stop was attempted, so the service comes back on the old version
 *   if the install fails;
 * - the console stays the TTY (`sudo` and the final prompt read from it);
 * - nothing free-form reaches the script: commands are the validated strings of
 *   the plan, and one containing a quote or a newline refuses the whole script.
 */
export function buildUpdateScript(commands: readonly string[], logPath: string): string | null {
  if (commands.length === 0) return null;
  if (!logPath.startsWith(`~/${UPDATE_LOG_DIR}/`)) return null;
  const usable = commands.filter((command) => typeof command === 'string' && command !== '');
  if (usable.length !== commands.length) return null;
  // A single quote would end the literal the command is embedded in; a newline
  // would split one command into two. Neither can come from the plan, so their
  // presence means the caller built something else.
  if (usable.some((command) => command.includes("'") || /[\r\n]/.test(command))) return null;

  const stop = usable.length >= 2 && STOP_LINE.test(usable[0] ?? '') ? (usable[0] as string) : null;
  const last = usable[usable.length - 1] ?? '';
  const start = stop !== null && START_LINE.test(last) ? last : null;
  const middle = usable.slice(stop === null ? 0 : 1, start === null ? usable.length : usable.length - 1);

  const lines: string[] = [
    '#!/bin/bash',
    '# DSH WSL console update: one attempt, the first failure decides the status.',
    `LOG=${logLiteral(logPath)}`,
    'mkdir -p "${LOG%/*}" || true',
    ': >"$LOG" || true',
    'exec > >(tee -a "$LOG") 2>&1',
    '',
    'fail=0',
    'run() {',
    '  printf \'\\n$ %s\\n\' "$1"',
    '  eval "$1"',
    '  local code=$?',
    '  if [ "$code" -ne 0 ] && [ "$fail" -eq 0 ]; then fail=$code; fi',
    '  return "$code"',
    '}',
  ];

  if (stop !== null) {
    // The stop is attempted, and the start below still runs even when it fails:
    // an update must never leave the owner without a service.
    lines.push(`run '${stop}' || true`);
  }
  for (const command of middle) {
    lines.push(`if [ "$fail" -eq 0 ]; then run '${command}' || true; fi`);
  }
  if (start !== null) {
    lines.push(`run '${start}' || true`);
  }
  lines.push(
    'printf \'\\nexit code: %s\\nlog: %s\\n\' "$fail" "$LOG"',
    'printf \'Press Enter to close this window...\'',
    'read -r _ 2>/dev/null || true',
    'exit "$fail"',
    '',
  );
  return lines.join('\n');
}

/** What the console reported and what the app read afterwards. */
export interface UpdateConsoleOutcome {
  /** Exit code of the script, `null` when the console could not be started. */
  code: number | null;
  /** Log path inside WSL, as shown to the owner. */
  logPath: string;
  /** Installed version before the run, `null` when unknown. */
  before: string | null;
  /** Installed version read after the run, `null` when it could not be read. */
  after: string | null;
  /** Exact published version the run aimed at. */
  target: string | null;
  /** Installation the rollback command would install into, `null` when unknown. */
  installation: DshInstallation | null;
}

export type UpdateConsoleResult = UpdateRunResult;

/**
 * Turn the console exit and the re-read versions into what the window says.
 *
 * The version, not the exit code, decides success: npm can exit non-zero after
 * writing the files, and a closed console reports a signal rather than a code.
 */
export function buildUpdateResult(outcome: UpdateConsoleOutcome): UpdateConsoleResult {
  const { code, logPath, before, after, target, installation } = outcome;
  const success = after !== null && target !== null && after === target;
  const rollbackCommand =
    success || installation === null || before === null ? null : buildInstallCommand(installation, before);

  let message: string;
  if (success) {
    message = `DeepSeek Harness ${after} is installed. The backend is running again.`;
  } else if (code === null) {
    message = 'The console could not be started. Nothing was changed.';
  } else if (after === null) {
    message = `The console closed with code ${code}, and the installed version could not be read. See the log.`;
  } else if (after === before) {
    message = `The console closed with code ${code} and the installation was not changed. See the log, then the service is up again on ${after}.`;
  } else {
    message = `The console closed with code ${code}; the installation reports ${after} instead of ${target}. See the log.`;
  }

  return {
    success,
    code,
    installed: after,
    target,
    logPath,
    rollbackCommand,
    message,
  };
}

/** Does this plan belong in a console at all? Mirrors `plan.runInConsole`. */
export function planRunsInConsole(plan: ManualUpdatePlan): boolean {
  return plan.runInConsole && plan.state === 'pending' && plan.commands.length > 0;
}
