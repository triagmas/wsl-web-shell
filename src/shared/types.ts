/** Shared, renderer-safe type definitions. No Electron or Node imports here. */

export const PRESET_DEEPSEEK_HARNESS = 'deepseek-harness' as const;

/**
 * Default root of the isolated backend environment (runtime, `DSH_HOME`,
 * `DSH_AGENTS_HOME`, caches, temp and the test workspace all live below it).
 */
export const ISOLATION_ROOT_DEFAULT = '~/.local/share/wsl-web-shell' as const;
export type PresetId = typeof PRESET_DEEPSEEK_HARNESS;

/** Lifecycle states from `docs/spec.md`. The values are also used in logs. */
export type LifecycleState =
  | 'CHECKING'
  | 'STARTING_WSL'
  | 'STARTING_WEB'
  | 'CONNECTING'
  | 'READY'
  | 'HIDDEN_IN_TRAY'
  | 'RECOVERING'
  | 'ERROR'
  | 'QUITTING';

/** Persistent application configuration (app profile only). */
export interface AppConfig {
  presetId: PresetId;
  /** Existing WSL distribution used for the backend. Never created by the app. */
  distro: string;
  /** Loopback port of the backend WebUI. */
  port: number;
  /** Working directory inside WSL; the DSH web profile treats it as workspace root. */
  workspace: string;
  /** Optional absolute POSIX path to the `dsh` executable inside WSL. */
  dshPath: string | null;
  /** Keep the backend in a private environment (runtime, DSH_HOME, agents home). */
  isolateEnvironment: boolean;
  /** Root directory of the isolated environment inside the distribution. */
  runtimeRoot: string;
  /** Show the window as soon as the shell is ready. */
  openOnLaunch: boolean;
  /** Supervise the owned backend and restart it after unexpected loss. */
  autoRestart: boolean;
  /** Upper bound of consecutive automatic restart attempts. */
  maxRestartAttempts: number;
}

/** Snapshot published to the splash/settings surfaces and the tray. */
export interface ShellStatus {
  state: LifecycleState;
  /** Short, user-facing stage text. Never contains secrets or tokens. */
  message: string;
  /** Optional actionable detail (install hint, collision hint, ...). */
  detail: string | null;
  /** True when the backend process is owned (and stoppable) by this app. */
  ownedServer: boolean;
  canRetry: boolean;
  port: number;
  distro: string;
  /** Restart attempt counter of the current recovery episode. */
  attempt: number;
  maxAttempts: number;
  /** Path of the local log file, shown in the diagnostics view. */
  logPath: string | null;
  /**
   * Version reported by the DSH executable this app selected, `null` until it is
   * known (or when it cannot be queried). Informational only.
   */
  dshVersion: string | null;
  /**
   * Executable the launcher resolved inside the distribution, `null` before the
   * first successful start. Used to decide whether an update may replace the
   * isolated runtime (issue #12).
   */
  dshPath: string | null;
  updatedAt: string;
}

/** Newest published upstream DSH release, as reported by the GitHub API. */
export interface LatestVersionInfo {
  /** Release version without the `dsh-v` tag prefix, e.g. `0.2.2-rc.1`. */
  version: string;
  /** HTML URL of the upstream release. Opens in the system browser only. */
  url: string;
  /** True when the upstream release is marked as a pre-release. */
  prerelease: boolean;
  /** Release publication timestamp, ISO 8601. */
  publishedAt: string;
}

/** Footer payload: installed version plus the cached upstream lookup state. */
export interface VersionSnapshot {
  /** Version of the DSH executable currently selected, `null` while unknown. */
  installed: string | null;
  /** Last successfully fetched upstream release, `null` when never fetched. */
  latest: LatestVersionInfo | null;
  /** When the upstream lookup last succeeded, ISO 8601, `null` if never. */
  checkedAt: string | null;
  /** Last lookup error, already sanitized and short, `null` when healthy. */
  error: string | null;
  /** True when the upstream release is strictly newer than the installed one. */
  updateAvailable: boolean;
}

/**
 * What the update confirmation window shows (issue #12). It is a snapshot: the
 * window renders it and never queries WSL itself.
 */
export interface UpdateProbe {
  /** Version currently in use, `null` while unknown. */
  installed: string | null;
  /** Exact published version the update would install. */
  target: string | null;
  distro: string;
  /** Isolated runtime root that would be replaced. */
  runtimeRoot: string;
  /** True when the update may be started; `reason` explains a refusal. */
  eligible: boolean;
  /** Machine-readable refusal code, `null` when eligible. */
  reason: string | null;
  /** Human-readable explanation for the window. */
  description: string | null;
  /** Directory that keeps the previous installation for rollback. */
  rollbackPath: string | null;
  /** True while an update is already running. */
  running: boolean;
}

export interface UpdateStartResult {
  started: boolean;
  reason: string | null;
  description: string | null;
}

export interface ConfigPatch {
  distro?: string;
  port?: number;
  workspace?: string;
  dshPath?: string | null;
  isolateEnvironment?: boolean;
  runtimeRoot?: string;
  openOnLaunch?: boolean;
  autoRestart?: boolean;
  maxRestartAttempts?: number;
}

export const DEFAULT_CONFIG: AppConfig = {
  presetId: PRESET_DEEPSEEK_HARNESS,
  distro: 'Ubuntu',
  port: 3080,
  workspace: '~',
  dshPath: null,
  isolateEnvironment: true,
  runtimeRoot: ISOLATION_ROOT_DEFAULT,
  openOnLaunch: true,
  autoRestart: true,
  maxRestartAttempts: 4,
};

export const LOOPBACK_HOST = '127.0.0.1' as const;
