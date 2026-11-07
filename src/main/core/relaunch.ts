/**
 * Relaunch after a successful update (issue #12).
 *
 * A portable Electron build runs from a temporary extraction directory, so
 * `process.execPath` is *not* the file the user started: relaunching it starts a
 * copy that is deleted as soon as the original process exits. The only correct
 * target is the portable executable itself, which electron-builder exposes as
 * `PORTABLE_EXECUTABLE_FILE`.
 *
 * The decision is pure, so it can be tested without Electron: given the
 * environment and a file-existence probe, it says whether a relaunch is safe or
 * whether the user has to start the app manually (in which case the update must
 * not be reported as "restarting automatically").
 */

export interface RelaunchEnvironment {
  /** `PORTABLE_EXECUTABLE_FILE` of the running portable build, if any. */
  portableExecutableFile: string | null;
  /** `process.execPath` of the running process. */
  execPath: string;
  /** `process.platform`. */
  platform: string;
}

export interface RelaunchTarget {
  /** Executable that must be started again. */
  execPath: string;
  /** True when the target is the portable EXE rather than a dev/asar copy. */
  portable: boolean;
}

export type RelaunchDecision =
  | { ok: true; target: RelaunchTarget }
  | { ok: false; reason: 'portable-missing' | 'portable-not-a-file' | 'not-windows' };

/** Only a real Windows executable is a valid relaunch target. */
function looksLikeExecutable(path: string): boolean {
  return /\.exe$/i.test(path) && !path.includes('\u0000');
}

/**
 * Decide what to start after an update finished.
 *
 * `exists` is injected so the decision can be tested without touching the disk.
 */
export function resolveRelaunchTarget(
  env: RelaunchEnvironment,
  exists: (path: string) => boolean = () => false,
): RelaunchDecision {
  if (env.platform !== 'win32') return { ok: false, reason: 'not-windows' };
  const portable = env.portableExecutableFile;
  if (portable === null || portable.trim() === '') {
    // Development run, unpacked build or a non-portable package: the app cannot
    // know the file the user started, so it must not pretend to restart itself.
    return { ok: false, reason: 'portable-missing' };
  }
  if (!looksLikeExecutable(portable)) return { ok: false, reason: 'portable-not-a-file' };
  if (!exists(portable)) return { ok: false, reason: 'portable-not-a-file' };
  return { ok: true, target: { execPath: portable, portable: true } };
}

/** Message shown in the terminal window when no automatic relaunch is possible. */
export function describeRelaunchFailure(reason: 'portable-missing' | 'portable-not-a-file' | 'not-windows'): string {
  switch (reason) {
    case 'portable-missing':
      return 'The upstream version was installed and verified. This build was not started from the portable EXE, so it cannot restart itself: quit and start WSL Web Shell again to use the new version.';
    case 'portable-not-a-file':
      return 'The upstream version was installed and verified, but the portable executable could not be found. Start WSL Web Shell again manually to use the new version.';
    case 'not-windows':
      return 'The upstream version was installed and verified. Automatic restart is only available in the Windows build; start the app again to use the new version.';
  }
}
