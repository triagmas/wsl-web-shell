/**
 * Backend supervisor: startup, ownership, health, bounded recovery, shutdown.
 *
 * All side effects arrive through injected gateways, so the whole lifecycle is
 * unit-testable without Electron, WSL or a real DeepSeek Harness installation.
 */
import type { AppConfig, LifecycleState, ShellStatus } from '../../shared/types.js';
import type { ManagedBackend } from '../wsl/managed.js';
import { LOOPBACK_HOST } from '../../shared/types.js';
import { parseStartupLine, buildOrigin } from '../backend/urls.js';
import type { ProcessProbe } from '../wsl/output.js';
import type { Logger } from './logger.js';
import type { ExternalBackendStore } from './external.js';
import type { RegistryStore } from './registry.js';
import { Lifecycle, backoffDelay } from './lifecycle.js';
import { verifyOwnership, type OwnedServerRecord } from './ownership.js';
import { classifyPortSituation, type PortState } from './port.js';
import { sanitizeOptional } from './display.js';
import { buildIsolationPlan, isolationRootArg, resolveLaunchWorkspace, type IsolationPlan } from './isolation.js';
import type { SharedDshReport } from './dsh-locate.js';

/**
 * How many ports above the configured one an app-owned backend may use while the
 * configured port stays reserved for the backend the owner runs.
 */
const FALLBACK_PORT_WINDOW = 8;

/**
 * Is this Windows pid still running?
 *
 * Signal 0 performs the existence check without delivering anything. It is the
 * only cheap liveness probe for a process the app created but does not reap.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Is `port` one of the fallback ports that belong to `base`? */
function isFallbackPort(port: number, base: number): boolean {
  return Number.isInteger(port) && port > base && port <= base + FALLBACK_PORT_WINDOW && port <= 65535;
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
}

export interface ServerHandle {
  /** Resolves once the wrapper announced the Linux PID. */
  pid: Promise<number | null>;
  /** Lines already emitted, so late subscribers never miss the URL line. */
  lines(): string[];
  onLine(listener: (line: string) => void): () => void;
  exited: Promise<ExitInfo>;
  /** Terminates the Windows-side `wsl.exe` launcher. */
  stop(): Promise<void>;
  stderrTail(): string;
}

export interface StartServerRequest {
  distro: string;
  dshPath: string;
  port: number;
  workspace: string;
  host: string;
  /** Validated isolated environment root, or `-` when isolation is disabled. */
  isolationRoot: string;
  /** Resolved node binary used to build the launcher PATH, or null. */
  nodePath: string | null;
}

export interface ResolvedRuntime {
  dshPath: string;
  nodePath: string | null;
  /**
   * Canonical (symlink-resolved) isolation root reported by WSL, `null` when the
   * backend was resolved without isolation. It is where the isolated **data**
   * lives (issue #17); the executable is not inside it.
   */
  canonicalRoot?: string | null;
  /** `readlink -f` of `dshPath`, `null` when it could not be resolved. */
  realPath?: string | null;
  /** Where the executable was found (login shell, PATH, fallback, custom). */
  source?: 'login-shell' | 'path' | 'fallback' | 'custom' | null;
  /** True when an older private `<root>/runtime/bin/dsh` still exists. */
  legacyRuntimePresent?: boolean;
}

export interface InspectSharedRequest {
  distro: string;
  appRoot: string;
  /** Executable to inspect, `null` lets the script resolve the distribution's one. */
  dshPath: string | null;
  nodePath: string | null;
  ownPid: number | null;
}

export interface WslGateway {
  listDistros(): Promise<string[]>;
  /** Any `wsl.exe` invocation starts a stopped distribution. */
  ensureDistro(distro: string): Promise<void>;
  /** Resolve the distribution's own `dsh` and `node` (read-only). */
  resolveRuntime(distro: string, override: string | null, isolationRoot: string | null): Promise<ResolvedRuntime>;
  /** Create the isolated data directories below the validated root. */
  prepareIsolation(distro: string, root: string): Promise<void>;
  startServer(request: StartServerRequest): ServerHandle;
  probeProcess(distro: string, pid: number): Promise<ProcessProbe | null>;
  /**
   * PID of the process listening on one TCP port inside the distribution, or
   * `null` when it cannot be resolved. Read-only; used to verify a backend the
   * app did not start.
   */
  findPortOwner(distro: string, port: number, nodePath: string | null): Promise<number | null>;
  /**
   * Keep the distribution alive while a backend the app does not own is serving.
   *
   * Left behind on quit on purpose: WSL2 powers a distribution off
   * about ten seconds after its last client exits, so a session owned by this
   * process would take the owner's backend down with the app. Returns the PID of
   * the session in use, or `null` when none could be kept.
   */
  ensureKeepalive(distro: string, nodePath: string | null): Promise<number | null>;
  /** `dsh --version` of the selected executable; `null` when it cannot be read. */
  dshVersion(distro: string, dshPath: string, nodePath: string | null): Promise<string | null>;
  /** Read-only provenance of the installation the launcher runs (issue #17). */
  inspectSharedDsh(request: InspectSharedRequest): Promise<SharedDshReport>;
  /**
   * Read-only discovery of the systemd unit behind an attached backend.
   *
   * Only the manual update window uses it, to name the unit in an instruction;
   * the app never stops or starts that unit itself.
   */
  probeManagedBackend(request: { distro: string; pid: number }): Promise<ManagedBackend>;
  signal(distro: string, pid: number, signal: 'TERM' | 'KILL'): Promise<void>;
}

export interface WebClient {
  /** Exchanges the tokenized startup URL for a session cookie. */
  bootstrapToken(tokenUrl: string): Promise<number>;
  /** Unauthenticated-by-URL health probe against the loopback origin. */
  health(origin: string): Promise<number>;
}

export interface SupervisorDeps {
  config(): AppConfig;
  wsl: WslGateway;
  web: WebClient;
  registry: RegistryStore;
  /**
   * Remembers that the fixed port is served by a backend the owner started, so
   * a later launch waits for it instead of spawning a competitor.
   */
  external: ExternalBackendStore;
  log: Logger;
  probePort(port: number): Promise<PortState>;
  sleep(ms: number): Promise<void>;
  now(): number;
  publish(status: ShellStatus): void;
  appVersion: string;
  logPath(): string;
  startupTimeoutMs?: number;
  healthAttempts?: number;
  stopGraceMs?: number;
  /** Bounded wait for an expected external backend before giving up. */
  attachWaitMs?: number;
  /** Poll interval used while waiting for that backend. */
  attachPollMs?: number;
  /** Cold-start head start for a launcher this profile has not attached to yet. */
  discoveryGraceMs?: number;
  /** Poll interval used during that discovery window. */
  discoveryPollMs?: number;
  /**
   * Liveness of a keepalive session. Tests inject it; production checks the
   * Windows pid the app created.
   */
  keepaliveAlive?(pid: number): boolean;
}

export type ShellErrorCode =
  | 'wsl-missing'
  | 'distro-missing'
  | 'dsh-missing'
  | 'port-collision'
  | 'start-timeout'
  | 'auth-failed'
  | 'health-failed'
  | 'backend-lost'
  | 'retry-exhausted'
  | 'runtime-blocked'
  | 'unexpected';

export class ShellError extends Error {
  constructor(
    readonly code: ShellErrorCode,
    message: string,
    readonly hint: string | null = null,
  ) {
    super(message);
    this.name = 'ShellError';
  }
}

/** States a lost backend can be recovered from without breaking the machine. */
const RECOVERABLE_STATES: readonly LifecycleState[] = [
  'STARTING_WEB',
  'CONNECTING',
  'READY',
  'HIDDEN_IN_TRAY',
  'RECOVERING',
];

const STATE_MESSAGES: Record<LifecycleState, string> = {
  CHECKING: 'Checking environment',
  STARTING_WSL: 'Starting Windows Subsystem for Linux',
  STARTING_WEB: 'Starting DeepSeek Harness',
  CONNECTING: 'Connecting to WebUI',
  READY: 'Ready',
  HIDDEN_IN_TRAY: 'Running in the notification area',
  RECOVERING: 'Reconnecting',
  ERROR: 'Backend unavailable',
  QUITTING: 'Shutting down',
};

export class Supervisor {
  private readonly lifecycle = new Lifecycle();
  private status: ShellStatus;
  private lock: Promise<unknown> = Promise.resolve();
  private server: ServerHandle | null = null;
  private serverPid: number | null = null;
  private serverStartTime: string | null = null;
  /** Backend settings captured when the current server was brought up. */
  private activePort: number | null = null;
  private activeDistro: string | null = null;
  private owned = false;
  /**
   * The app is connected to a backend it does not own (started by the owner, for
   * example a systemd unit). Such a process is never signalled or restarted.
   */
  private attached = false;
  /** Pid of the attached backend: needed to find the unit that owns it. */
  private attachedPid: number | null = null;

  /**
   * Windows pid of the session holding the distribution open while attached.
   *
   * A linux-level check would need another `wsl.exe` run on every tick, so the
   * app watches the process it created instead. When that session dies the
   * distribution powers off about ten seconds later, taking the owner's backend
   * with it - the exact chain that ended two WebUI sessions on 2026-11-14.
   */
  private keepalivePid: number | null = null;

  /**
   * A console update owns the backend right now.
   *
   * While set, the app must not fight the update: no recovery, no hand-back, no
   * keepalive decision that starts or stops anything (the beta.6 EADDRINUSE bug
   * was exactly a supervisor racing a package swap). Only the two public methods
   * below change it.
   */
  private pausedForUpdate = false;
  /**
   * The profile expects this port to be served by a backend the owner started
   * (a previous attach succeeded). While true the app waits for that backend
   * first and starts its own only when it does not appear, so it never races the
   * owner's launcher for the fixed port (the boot race seen after beta.5).
   */
  private externalExpected = false;
  /** A hand-back to the launcher that just came up is in flight. */
  private handBackRunning = false;
  private failures = 0;
  private attempt = 0;
  private recoveryRunning = false;
  /** A recovery loop is queued or running; duplicates are dropped (issue #24). */
  private recoveryScheduled = false;
  /**
   * Monotonic id of every backend this supervisor spawned. Exit events carry the
   * generation of their own process, so an event from a replaced backend can
   * never trigger recovery for (or signal) its successor (issue #24).
   */
  private generation = 0;
  private serverGeneration = 0;
  /**
   * True between spawning a backend and deciding that its start failed. While a
   * start is in flight it owns the outcome: the exit handler must not start a
   * second, parallel recovery for the same process (issue #24).
   */
  private startInFlight = false;
  private quitting = false;
  private detail: string | null = null;
  /** Last known window visibility, so recovery can restore the tray state. */
  private windowHidden = false;
  private readyCount = 0;
  /** Version reported by the DSH executable in use, informational only. */
  private dshVersion: string | null = null;
  /** Runtime actually launched; `null` until a start resolved one (issue #12). */
  private runtime: ResolvedRuntime | null = null;

  constructor(private readonly deps: SupervisorDeps) {
    this.status = this.buildStatus('CHECKING', null);
    this.lifecycle.onChange((state) => {
      this.status = this.buildStatus(state, this.detail);
      this.deps.publish(this.status);
    });
  }

  /**
   * PID of the app-owned backend, `null` when nothing is owned.
   *
   * The read-only inspection excludes exactly this process from the "another DSH
   * process uses this installation" check, so the app never mistakes its own
   * backend for a foreign one.
   */
  ownedPid(): number | null {
    return this.owned ? this.serverPid : null;
  }

  getStatus(): ShellStatus {
    return this.status;
  }

  /**
   * Runtime the launcher resolved (`dsh` plus the Node.js that runs it),
   * `null` until a start succeeded. The inspection needs the same Node.js binary
   * so the version probe runs exactly like the backend is started.
   */
  resolvedRuntime(): ResolvedRuntime | null {
    return this.runtime;
  }

  /**
   * Pid of the backend this app started, for the manual update instructions.
   *
   * The update window says how to stop it, so it must name the real process: the
   * app deliberately leaves that backend running when the owner quits.
   */
  ownedBackendPid(): number | null {
    return this.owned ? this.serverPid : null;
  }

  get state(): LifecycleState {
    return this.lifecycle.state;
  }

  /**
   * Increments every time the backend becomes usable. The window layer uses it
   * to force a real reload after a restart instead of trusting the old page.
   */
  get readyGeneration(): number {
    return this.readyCount;
  }

  /** True when the user closed the window to the tray. */
  get isWindowHidden(): boolean {
    return this.windowHidden;
  }

  private buildStatus(state: LifecycleState, detail: string | null): ShellStatus {
    const config = this.deps.config();
    return {
      state,
      message: STATE_MESSAGES[state],
      // Every published string is sanitized: diagnostics may embed backend
      // output, exception text or a URL that once carried a launch token.
      detail: sanitizeOptional(detail),
      ownedServer: this.owned,
      externalBackend: this.attached,
      canRetry: state === 'ERROR',
      port: this.port(),
      distro: config.distro,
      attempt: this.attempt,
      maxAttempts: config.maxRestartAttempts,
      logPath: this.deps.logPath(),
      dshVersion: this.dshVersion,
      dshPath: this.runtime?.dshPath ?? null,
      updatedAt: new Date(this.deps.now()).toISOString(),
    };
  }

  private port(): number {
    return this.activePort ?? this.deps.config().port;
  }

  private distro(): string {
    return this.activeDistro ?? this.deps.config().distro;
  }

  private setState(state: LifecycleState, detail: string | null = null): void {
    this.detail = detail;
    if (state === this.lifecycle.state) {
      this.status = this.buildStatus(state, detail);
      this.deps.publish(this.status);
      return;
    }
    this.lifecycle.transition(state);
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.lock.then(task, task);
    this.lock = run.catch(() => undefined);
    return run;
  }

  /** First launch or manual retry: serialized, never parallel. */
  start(): Promise<void> {
    return this.serial(async () => {
      if (this.quitting) return;
      // Repeated launches must never spawn a second server for the same port.
      if (this.owned && (this.lifecycle.state === 'READY' || this.lifecycle.state === 'HIDDEN_IN_TRAY' || this.lifecycle.state === 'CONNECTING')) {
        return;
      }
      this.attempt = 0;
      await this.bringUp();
    });
  }

  /** Tray "Restart WebUI": restarts the app-owned backend, or takes the port back. */
  restart(): Promise<void> {
    return this.serial(async () => {
      if (this.quitting) return;
      if (this.attached) {
        this.setDetail('The backend runs outside this app; restart it with its own service.');
        return;
      }
      if (!this.owned && !this.externalExpected) {
        this.setDetail('Only the backend started by this app can be restarted.');
        return;
      }
      if (this.externalExpected) {
        // Explicit owner intent: the port is reserved for a backend the owner
        // runs, and they asked the app to serve it instead. Drop the reservation
        // before restarting, whether or not a fallback backend is running now.
        this.deps.log.info('restart: the owner asked the app to take the port; dropping the external expectation');
        this.clearExternalExpectation();
      }
      this.attempt = 0;
      this.setState('RECOVERING', 'Restarting DeepSeek Harness');
      await this.stopOwnedServer();
      await this.bringUp();
    });
  }

  /** Retry from a terminal error state. */
  retry(): Promise<void> {
    return this.serial(async () => {
      if (this.quitting) return;
      if (this.lifecycle.state === 'ERROR') this.setState('CHECKING', null);
      this.attempt = 0;
      await this.bringUp();
    });
  }

  /**
   * Pause the supervisor because a console update owns the backend.
   *
   * The app stops its own backend here, through the existing ownership-proven
   * path, so the console never needs a `kill` line for a process it did not
   * start. An attached backend is left alone: the console's own unit commands
   * own it.
   */
  suspendForUpdate(): Promise<void> {
    return this.serial(async () => {
      if (this.pausedForUpdate || this.quitting) return;
      this.pausedForUpdate = true;
      this.deps.log.info('supervisor paused for the console update');
      await this.stopOwnedServer();
    });
  }

  /**
   * Resume after a console update, whatever its outcome.
   *
   * Runs the ordinary bring-up path: it re-attaches to the restarted unit or
   * starts an app-owned backend again. A failure here is logged, not escalated:
   * the owner already sees the console result, and the health loop continues.
   */
  resumeAfterUpdate(): Promise<void> {
    return this.serial(async () => {
      if (!this.pausedForUpdate) return;
      this.pausedForUpdate = false;
      this.deps.log.info('supervisor resumed after the console update');
      this.failures = 0;
      this.attempt = 0;
      if (this.quitting) return;
      try {
        await this.bringUp();
      } catch (error) {
        this.deps.log.error(`could not restart the backend after the update: ${describe(error)}`);
      }
    });
  }

  /**
   * Read-only unit of the backend the app is attached to.
   *
   * The manual update window names that unit in the commands it shows, so the
   * discovery has to be real and has to happen when the window opens. Nothing
   * here stops, starts or signals the unit; `null` means the backend is
   * app-owned, not running, or the probe failed.
   */
  async discoverAttachedUnit(): Promise<ManagedBackend | null> {
    const pid = this.attachedPid;
    if (!this.attached || pid === null) return null;
    try {
      return await this.deps.wsl.probeManagedBackend({ distro: this.distro(), pid });
    } catch (error) {
      this.deps.log.warn(`could not identify the unit of the attached backend: ${describe(error)}`);
      return null;
    }
  }


  markHidden(hidden: boolean): void {
    this.windowHidden = hidden;
    const state = this.lifecycle.state;
    if (hidden && state === 'READY') {
      this.setState('HIDDEN_IN_TRAY', null);
    } else if (!hidden && state === 'HIDDEN_IN_TRAY') {
      this.setState('READY', null);
    }
  }

  /** Health tick driven by the main process (visible ~10 s, hidden ~25 s). */
  async healthTick(): Promise<void> {
    if (this.pausedForUpdate) return;
    const state = this.lifecycle.state;
    if (state !== 'READY' && state !== 'HIDDEN_IN_TRAY') return;
    const origin = buildOrigin(this.port());
    let code: number;
    try {
      code = await this.deps.web.health(origin);
    } catch {
      code = 0;
    }
    if (code === 200) {
      this.failures = 0;
      await this.repairDistroKeepalive();
      await this.maybeHandBack();
      return;
    }
    this.failures += 1;
    this.deps.log.warn(`health probe failed (status=${code}, consecutive=${this.failures})`);
    if (this.failures < 2) return;
    this.failures = 0;
    await this.handleLoss('health-check-failed');
  }

  /** Unexpected process death, wired by the main process. */
  async handleServerExit(exit: ExitInfo, generation: number = this.serverGeneration): Promise<void> {
    if (generation !== this.serverGeneration) {
      // The backend this event belongs to was already replaced: acting on it
      // would make the replacement look dead and could stop the wrong process.
      this.deps.log.debug(
        `backend exit ignored: event generation ${generation} is not the current backend (${this.serverGeneration})`,
      );
      return;
    }
    if (this.startInFlight) {
      // The start that owns this process reports the failure itself, once, with
      // the backend's own output. A second reporter here would duplicate the
      // recovery and race the lifecycle (issue #24).
      this.deps.log.debug(
        `backend exit observed while its start is in flight (code=${exit.code ?? 'null'}); the start reports it`,
      );
      return;
    }
    if (this.quitting || this.lifecycle.state === 'QUITTING' || this.lifecycle.state === 'ERROR') return;
    const active: LifecycleState[] = ['STARTING_WEB', 'CONNECTING', 'READY', 'HIDDEN_IN_TRAY'];
    if (!active.includes(this.lifecycle.state)) return;
    this.deps.log.warn(`backend exited unexpectedly (code=${exit.code ?? 'null'}, signal=${exit.signal ?? 'null'})`);
    await this.handleLoss('process-exited');
  }

  /**
   * Bounded self-healing after an owned backend was lost.
   *
   * Recovery runs under the same lock as manual starts, so lifecycle
   * transitions can never interleave, and duplicate requests (an exit event and
   * a failing health tick for the same process) produce one loop (issue #24).
   */
  private async handleLoss(reason: string): Promise<void> {
    if (this.pausedForUpdate) {
      // The stop belonged to the update, not to an accident: the console is
      // about to install and start the service again.
      this.deps.log.debug(`loss ignored (${reason}): a console update owns the backend`);
      return;
    }
    if (this.recoveryRunning || this.recoveryScheduled || this.quitting) return;
    if (this.attached) {
      // The backend belongs to its own launcher, so the app must not signal or
      // stop it. Normal recovery is safe here: it re-attaches to that backend
      // when its launcher brings it back, and only starts an app-owned one when
      // it really is gone (see bringUp and the external expectation).
      this.attached = false;
      this.attachedPid = null;
      this.deps.log.warn(`attached backend lost (${reason}); recovery re-attaches or starts an app-owned backend`);
    }
    if (this.startInFlight) {
      this.deps.log.debug(`recovery skipped (${reason}): a start is in flight and owns the outcome`);
      return;
    }
    this.recoveryScheduled = true;
    try {
      await this.serial(async () => {
        this.recoveryScheduled = false;
        if (this.quitting || this.startInFlight) return;
        if (!RECOVERABLE_STATES.includes(this.lifecycle.state)) {
          this.deps.log.debug(`recovery not needed (${reason}): state is ${this.lifecycle.state}`);
          return;
        }
        this.recoveryRunning = true;
        try {
          await this.runRecovery(reason);
        } finally {
          this.recoveryRunning = false;
        }
      });
    } finally {
      this.recoveryScheduled = false;
    }
  }

  private async runRecovery(reason: string): Promise<void> {
    this.setState('RECOVERING', reason === 'process-exited' ? 'DeepSeek Harness stopped unexpectedly' : 'Connection to DeepSeek Harness lost');
    this.deps.log.info(`recovery started (${reason})`);

    // Keep the recorded PID/start time until the process is proven gone or
    // stopped: a hung-but-alive backend still has to be reclaimed safely.
    await this.releaseOwnedProcess();

    const config = this.deps.config();
    if (!config.autoRestart) {
      this.owned = false;
      this.fail(new ShellError('backend-lost', 'The DeepSeek Harness web server is not running.', 'Automatic restart is disabled in settings.'));
      return;
    }

    for (let attempt = 1; attempt <= config.maxRestartAttempts; attempt += 1) {
      this.attempt = attempt;
      this.setState('RECOVERING', `Restarting backend (attempt ${attempt} of ${config.maxRestartAttempts})`);
      await this.deps.sleep(backoffDelay(attempt - 1));
      if (this.quitting) return;
      try {
        await this.bringUp();
        this.deps.log.info(`recovery succeeded on attempt ${attempt}`);
        this.attempt = 0;
        return;
      } catch (error) {
        this.deps.log.error(`recovery attempt ${attempt} failed: ${describe(error)}`);
        if (error instanceof ShellError && error.code === 'port-collision') {
          this.fail(error);
          return;
        }
      }
    }
    this.fail(
      new ShellError(
        'retry-exhausted',
        `The web server could not be restarted after ${config.maxRestartAttempts} attempts.`,
        'Use Retry after checking the log and the WSL distribution.',
      ),
    );
  }

  private async bringUp(): Promise<void> {
    const config = this.deps.config();
    try {
      this.activePort = config.port;
      this.activeDistro = config.distro;
      this.attached = false;
      this.attachedPid = null;
      this.externalExpected = this.expectExternalBackend();
      this.setState('CHECKING', null);
      this.failures = 0;

      const distros = await this.deps.wsl.listDistros();
      if (!distros.includes(config.distro)) {
        throw new ShellError(
          'distro-missing',
          `WSL distribution "${config.distro}" is not installed.`,
          'Install the distribution (for example "wsl --install -d Ubuntu") or pick another distro in Settings.',
        );
      }

      this.setState('STARTING_WSL', `Starting ${config.distro}`);
      await this.deps.wsl.ensureDistro(config.distro);

      // A previous in-session backend (healthy, hung or already dead) is
      // resolved before anything else can fail, so a hung owned process never
      // survives a failed recovery attempt.
      await this.releaseOwnedProcess();

      const plan = this.isolationPlan(config);
      if (plan.enabled) {
        this.setState('STARTING_WSL', `Preparing isolated environment in ${config.distro}`);
        await this.deps.wsl.prepareIsolation(config.distro, plan.root);
      }
      const runtime = await this.deps.wsl.resolveRuntime(
        config.distro,
        config.dshPath,
        plan.enabled ? plan.root : null,
      );
      this.runtime = { ...runtime, canonicalRoot: runtime.canonicalRoot ?? null };
      await this.refreshDshVersion(config.distro, runtime.dshPath, runtime.nodePath);

      // A backend this app started on a fallback port in an earlier run is
      // adopted instead of orphaned: leaving it running would keep a second
      // writer on the same DSH profile. The record alone is not enough - after a
      // distribution restart the recorded PID is gone while the launcher may
      // already serve its own port - so discovery only moves to the fallback
      // port for a process that is still verifiably this app's backend.
      const recorded = this.deps.registry.read();
      if (
        recorded !== null &&
        recorded.distro === config.distro &&
        isFallbackPort(recorded.port, config.port)
      ) {
        // `undefined` marks a probe that failed, which is not evidence of a dead
        // process: the record is kept so a later start can still adopt it.
        const probe = await this.deps.wsl.probeProcess(config.distro, recorded.pid).catch((error: unknown) => {
          this.deps.log.warn(
            `could not verify the backend on fallback port ${recorded.port}: ${describe(error)}`,
          );
          return undefined;
        });
        if (probe === undefined) {
          this.deps.log.info(
            `serving on port ${config.port}; the app-owned backend on fallback port ${recorded.port} stays recorded for a later start`,
          );
        } else {
          const proof = verifyOwnership(probe, { port: recorded.port, startTime: recorded.startTime });
          if (proof === 'owned') {
            this.deps.log.info(`adopting the app-owned backend on fallback port ${recorded.port}`);
            this.activePort = recorded.port;
          } else {
            this.deps.registry.clear();
            this.deps.log.info(
              `the app-owned backend on fallback port ${recorded.port} is gone; looking for the launcher on port ${config.port}`,
            );
          }
        }
      }

      const portState = await this.deps.probePort(this.port());
      let reassessed = portState;
      let startOwn = false;
      if (portState === 'occupied') {
        const existing = await this.verifyRecordedServer();
        const situation = classifyPortSituation(portState, existing.verdict);
        if (situation === 'collision') {
          // The record is the only proof of ownership the next start can use;
          // an inconclusive probe here is not evidence that it is stale. Keep
          // it so a transient probe failure cannot permanently orphan a live
          // backend the way beta.4 did.
          // A verified DSH backend that is still starting answers the port
          // before it accepts this profile's session, so the attach gets the
          // same bounded window as a launcher that has yet to appear.
          const outcome = await this.awaitExternal(runtime.nodePath);
          if (outcome === 'attached') {
            await this.finishReady();
            return;
          }
          if (outcome === 'rejected') {
            throw new ShellError(
              'port-collision',
              `Port ${config.port} is already in use by a service this app does not own.`,
              'A DSH backend started outside this app holds the port, and this app profile has never authenticated against it, so it cannot be trusted yet. Stop it and let the app start its own backend, or choose another port in Settings.',
            );
          }
          // The listener exited while it was being waited for: the port is free
          // again, so serve the WebUI with an app-owned backend instead of
          // reporting a collision with a service that is gone.
          if (this.quitting) return;
          this.deps.log.warn(`the listener on port ${config.port} left while waiting for it; starting an app-owned backend`);
          startOwn = true;
        }
        if (!startOwn) {
          this.deps.log.info('reusing app-owned backend');
          this.owned = true;
          this.serverPid = existing.record?.pid ?? null;
          this.serverStartTime = existing.record?.startTime ?? null;
          // Keep the expectation: an app-owned fallback only borrows the port
          // until the distribution boots again, when the owner's launcher is
          // expected to serve it. The miss counter drops it after three absences.
          this.setState('CONNECTING', null);
          const authenticated = await this.tryExistingSession();
          if (authenticated) {
            await this.finishReady();
            return;
          }
          this.deps.log.warn('owned backend rejected the stored session cookie; restarting it');
          await this.stopOwnedServer();
          reassessed = await this.deps.probePort(this.port());
          if (reassessed === 'occupied') {
            throw new ShellError(
              'port-collision',
              `Port ${config.port} is still in use after stopping the app-owned backend.`,
              'Check the port with "ss -ltnp" inside WSL and pick another port in Settings.',
            );
          }
        }
      }

      if (!startOwn && portState !== 'occupied' && this.externalExpected) {
        // This profile has attached to an external backend before, so the port
        // belongs to its launcher, not to this app. Wait for it first: when it
        // answers, the app attaches instead of starting a competitor.
        const misses = this.deps.external.read()?.misses ?? 0;
        if (misses >= 3) {
          // The launcher has been away for several starts. The port stays
          // reserved for it, but the app no longer spends the wait on every
          // start: it serves itself beside the port and hands the port back as
          // soon as the launcher answers (see maybeHandBack).
          this.deps.log.info('the launcher has not appeared in three starts; keeping its port free without waiting');
        } else {
          const outcome = await this.awaitExternal(runtime.nodePath);
          if (outcome === 'attached') {
            await this.finishReady();
            return;
          }
          if (outcome === 'rejected') {
            throw new ShellError(
              'port-collision',
              `Port ${config.port} is already in use by a service this app does not own.`,
              'The backend this profile used to attach to is no longer answering, and something else holds the port now. Close it or choose another port in Settings. The app never connects to unknown listeners.',
            );
          }
          // A wait that was canceled by quitting did not learn anything about
          // the launcher, so it must not count as a miss.
          if (this.quitting) return;
          const next = misses + 1;
          this.recordExternalExpectation(next);
          this.deps.log.warn(
            `no external backend appeared; keeping port ${config.port} free for its launcher (miss ${next} of 3)`,
          );
        }
      }

      if (!startOwn && portState !== 'occupied' && !this.externalExpected) {
        // First launch on a machine whose backend is started elsewhere (for
        // example a systemd unit that is still coming up after the same WSL
        // boot). Give that launcher a short head start before taking the port:
        // the cost is a few seconds on a cold start, the benefit is that the
        // app and the owner's unit never race for the port again.
        const discovered = await this.discoverExternal(runtime.nodePath);
        if (discovered) {
          await this.finishReady();
          return;
        }
      }

      const servePort = await this.chooseServePort(config);
      if (servePort !== this.port()) {
        this.deps.log.warn(
          `serving the app-owned backend on port ${servePort}: port ${config.port} stays free for the backend started outside this app`,
        );
      }
      this.activePort = servePort;
      await this.spawnServer(runtime, plan);
      await this.finishReady();
    } catch (error) {
      // Never leave a half-started process behind.
      await this.stopOwnedServer().catch(() => undefined);
      this.owned = false;
      this.fail(
        error instanceof ShellError
          ? error
          : new ShellError('unexpected', describe(error), 'See the log for details.'),
      );
      throw error;
    }
  }

  /**
   * Read the version of the executable that is actually in use.
   *
   * Read-only and fail-soft: an unhelpful CLI must not turn a working backend
   * into an error, so the footer simply shows "unknown".
   */
  private async refreshDshVersion(distro: string, dshPath: string, nodePath: string | null): Promise<void> {
    try {
      const version = await this.deps.wsl.dshVersion(distro, dshPath, nodePath);
      if (version === this.dshVersion) return;
      this.dshVersion = version;
      this.status = this.buildStatus(this.status.state, this.status.detail);
      this.deps.publish(this.status);
    } catch (error) {
      this.deps.log.debug(`dsh version query failed: ${describe(error)}`);
      if (this.dshVersion === null) return;
      this.dshVersion = null;
      this.status = this.buildStatus(this.status.state, this.status.detail);
      this.deps.publish(this.status);
    }
  }

  private isolationPlan(config: AppConfig): IsolationPlan {
    return buildIsolationPlan({ enabled: config.isolateEnvironment, root: config.runtimeRoot });
  }

  private async spawnServer(runtime: ResolvedRuntime, plan: IsolationPlan): Promise<void> {
    const config = this.deps.config();
    const workspace = resolveLaunchWorkspace(config.workspace, plan);
    this.setState('STARTING_WEB', null);

    // Every spawned backend gets its own generation. Exit events carry the
    // generation of the process they belong to, so the start below and the exit
    // handler can never both "own" the same failure (issue #24).
    const generation = (this.generation += 1);
    this.serverGeneration = generation;
    this.startInFlight = true;

    try {
      // A gateway that throws synchronously must not leave the flag stuck: the
      // bookkeeping is released by the finally below (review R02).
      const handle = this.deps.wsl.startServer({
        distro: config.distro,
        dshPath: runtime.dshPath,
        port: this.port(),
        workspace,
        host: LOOPBACK_HOST,
        isolationRoot: isolationRootArg(plan),
        nodePath: runtime.nodePath,
      });
      this.server = handle;
      this.owned = true;

      void handle.exited
        .then((exit) => this.handleServerExit(exit, generation))
        .catch((error: unknown) => this.deps.log.error(`exit handler failed: ${describe(error)}`));

      const pid = await this.raceExit(
        handle,
        this.withTimeout(handle.pid, 15_000, 'start-timeout', 'The backend did not report its process id.'),
        'before it reported its process id',
      );
      if (pid === null) {
        throw new ShellError('start-timeout', 'The backend did not report its process id.', 'See the log for the raw output.');
      }
      this.serverPid = pid;

      const probe = await this.raceExit(
        handle,
        this.waitForProbe(config.distro, pid, 5_000),
        'before its process could be verified',
      );
      const verdict = verifyOwnership(probe, { port: this.port() });
      if (verdict !== 'owned' || probe === null) {
        throw new ShellError(
          'unexpected',
          'The started process could not be verified as the DeepSeek Harness backend.',
          this.unverifiedHint(probe, verdict),
        );
      }
      this.serverStartTime = probe.startTime;
      this.deps.registry.write({
        presetId: config.presetId,
        distro: config.distro,
        port: this.port(),
        pid,
        startTime: probe.startTime,
        workspace,
        startedAt: new Date(this.deps.now()).toISOString(),
        appVersion: this.deps.appVersion,
      } satisfies OwnedServerRecord);

      this.setState('CONNECTING', null);
      // The URL wait is raced against the exit too: a backend that dies after
      // the ownership probe but before it announces its WebUI URL must fail
      // immediately, not after the startup timeout (review R02).
      const tokenUrl = await this.raceExit(
        handle,
        this.waitForStartupUrl(handle),
        'before it announced its WebUI URL',
      );
      const status = await this.deps.web.bootstrapToken(tokenUrl);
      if (status === 401 || status === 403) {
        throw new ShellError('auth-failed', 'The WebUI rejected the startup token.', 'Restart the backend from the tray menu.');
      }
      if (status >= 400) {
        throw new ShellError('auth-failed', `The WebUI login exchange failed (HTTP ${status}).`, 'Restart the backend from the tray menu.');
      }
    } finally {
      this.startInFlight = false;
    }
  }

  /**
   * Reject as soon as the backend process exits while its start is in flight.
   *
   * Without this the ownership probe could wait its full timeout on an already
   * dead process and then report a generic error that hides the real reason
   * (issue #24: exit 127 with a missing runtime `node` on PATH).
   */
  private async raceExit<T>(handle: ServerHandle, work: Promise<T>, phase: string): Promise<T> {
    let settled = false;
    const exitRace = handle.exited.then((exit) => {
      if (settled) return undefined as T;
      throw this.backendExitedError(exit, phase);
    });
    try {
      return await Promise.race([work, exitRace]);
    } finally {
      settled = true;
    }
  }

  private backendExitedError(exit: ExitInfo, phase: string): ShellError {
    const code = exit.code === null ? 'no exit code' : `code ${exit.code}`;
    const signal = exit.signal === null ? '' : `, signal ${exit.signal}`;
    const tail = sanitizeOptional(this.server?.stderrTail() ?? null);
    return new ShellError(
      'backend-lost',
      `The DeepSeek Harness backend exited with ${code}${signal} ${phase}.`,
      tail ?? 'Inspect the log for the backend output.',
    );
  }

  /** Say what was actually observed instead of only "not verified". */
  private unverifiedHint(probe: ProcessProbe | null, verdict: string): string {
    const tail = sanitizeOptional(this.server?.stderrTail() ?? null);
    const observed =
      probe === null
        ? `No live process with pid=${this.serverPid} was found when the launch was checked.`
        : `The process identity check returned "${verdict}".`;
    return ['The app only manages processes it can prove it started.', observed, tail]
      .filter((part): part is string => part !== null && part !== '')
      .join(' ');
  }

  private async waitForProbe(distro: string, pid: number, timeoutMs: number): Promise<ProcessProbe | null> {
    const deadline = this.deps.now() + timeoutMs;
    let probe: ProcessProbe | null = null;
    while (this.deps.now() <= deadline) {
      probe = await this.deps.wsl.probeProcess(distro, pid);
      if (probe !== null && probe.startTime !== '') return probe;
      await this.deps.sleep(150);
    }
    return probe;
  }

  private async waitForStartupUrl(handle: ServerHandle): Promise<string> {
    const deadline = this.deps.now() + (this.deps.startupTimeoutMs ?? 60_000);
    const tryParse = (lines: string[]): string | null => {
      for (const line of lines) {
        const parsed = parseStartupLine(line, { port: this.port() });
        if (parsed.ok) return parsed.tokenUrl;
        if (!parsed.ok && line.startsWith('dsh web: ') && parsed.error !== 'not-a-startup-line') {
          this.deps.log.warn(`rejected startup URL line (${parsed.error})`);
        }
      }
      return null;
    };

    const immediate = tryParse(handle.lines());
    if (immediate !== null) return immediate;

    return await new Promise<string>((resolve, reject) => {
      // Exactly one outcome may settle the wait, and every outcome releases the
      // timer and the line listener: a process that dies before announcing its
      // URL must neither leave a pending timer nor keep listening (review R02).
      let settled = false;
      const state: { timer?: NodeJS.Timeout; unsubscribe: () => void } = { unsubscribe: () => undefined };
      const cleanup = (): void => {
        if (settled) return;
        settled = true;
        if (state.timer !== undefined) clearTimeout(state.timer);
        state.unsubscribe();
      };

      state.timer = setTimeout(() => {
        cleanup();
        reject(new ShellError('start-timeout', 'The backend did not announce a WebUI URL in time.', 'Inspect the log: the backend may still be booting, or the frontend build is missing.'));
      }, Math.max(1_000, deadline - this.deps.now()));

      state.unsubscribe = handle.onLine((line) => {
        const found = tryParse([line]);
        if (found === null) return;
        cleanup();
        resolve(found);
      });

      void handle.exited.then((exit) => {
        const error = this.backendExitedError(exit, 'before it announced its WebUI URL');
        cleanup();
        reject(error);
      });
    });
  }

  private async tryExistingSession(): Promise<boolean> {
    const origin = buildOrigin(this.port());
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const status = await this.deps.web.health(origin);
        if (status === 200) return true;
        if (status === 401 || status === 403) return false;
      } catch {
        // Server may still be starting.
      }
      await this.deps.sleep(300);
    }
    return false;
  }

  private async finishReady(): Promise<void> {
    const origin = buildOrigin(this.port());
    const attempts = this.deps.healthAttempts ?? 20;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const status = await this.deps.web.health(origin);
      if (status === 200) {
        this.failures = 0;
        this.attempt = 0;
        this.readyCount += 1;
        // Restore the tray state the user chose: a hidden window stays hidden.
        const target: LifecycleState = this.windowHidden ? 'HIDDEN_IN_TRAY' : 'READY';
        if (this.lifecycle.state !== target) this.setState(target, null);
        this.deps.log.info('backend ready');
        if (this.attached) await this.ensureDistroKeepalive();
        return;
      }
      await this.deps.sleep(250);
    }
    throw new ShellError('health-failed', 'The WebUI did not answer over loopback.', 'Check the log and whether another process holds the port.');
  }

  private attachWaitMs(): number {
    return this.deps.attachWaitMs ?? 20_000;
  }

  private attachPollMs(): number {
    return Math.max(1, this.deps.attachPollMs ?? 1_000);
  }

  /**
   * Hold WSL open while an attached backend serves the WebUI.
   *
   * WSL2 powers a distribution off about ten seconds after its last client
   * exits, which kills every process inside it, the owner's backend included.
   * While attached the app owns no client, so it keeps one lightweight session.
   * Failure is logged, never fatal: the backend is alive at this point, and the
   * app must not turn a working WebUI into an error.
   */
  private async ensureDistroKeepalive(): Promise<void> {
    const nodePath = this.runtime?.nodePath ?? null;
    try {
      const pid = await this.deps.wsl.ensureKeepalive(this.distro(), nodePath);
      this.keepalivePid = pid;
      if (pid !== null) this.deps.log.info(`the distribution is kept open while attached (keepalive pid=${pid})`);
    } catch (error) {
      this.keepalivePid = null;
      this.deps.log.warn(`could not keep the distribution open: ${describe(error)}`);
    }
  }

  /**
   * Restart the keepalive session if whatever held the distribution open is gone.
   *
   * Leaving the distribution without a client is not a slow degradation: WSL2
   * powers it off within about ten seconds, which stops the owner's backend and
   * drops the WebUI. Re-arming the session is cheap and invisible; a failure here
   * is logged and retried on the next healthy tick rather than escalated.
   */
  private async repairDistroKeepalive(): Promise<void> {
    if (!this.attached || this.pausedForUpdate) return;
    const alive = this.deps.keepaliveAlive ?? isProcessAlive;
    if (this.keepalivePid !== null && alive(this.keepalivePid)) return;
    if (this.keepalivePid !== null) {
      this.deps.log.warn(`the session holding the distribution open is gone (pid=${this.keepalivePid}); re-arming it`);
    }
    await this.ensureDistroKeepalive();
  }

  /**
   * Port an app-owned backend should serve on.
   *
   * When this profile expects a launcher on the fixed port, the app serves
   * itself on the next free port instead. The launcher must always find its own
   * port free, otherwise its unit restarts forever on EADDRINUSE - which is
   * exactly what happened in beta.6. The window is small and bounded; when no
   * port beside the fixed one is free the app takes the fixed port rather than
   * leaving the owner without a WebUI.
   */
  private async chooseServePort(config: AppConfig): Promise<number> {
    if (!this.externalExpected) return config.port;
    for (let candidate = config.port + 1; candidate <= config.port + FALLBACK_PORT_WINDOW; candidate += 1) {
      if (candidate > 65535) break;
      if ((await this.deps.probePort(candidate)) === 'free') return candidate;
    }
    this.deps.log.warn(
      `no free port beside ${config.port}; the app-owned backend will use the port its launcher expects`,
    );
    return config.port;
  }

  /**
   * Hand the fixed port back to the launcher that came up meanwhile.
   *
   * Runs on the health tick, so the switch happens within one interval of the
   * launcher answering on its own port. Verification is the same pair the attach
   * uses - a listener whose command line is our `dsh web` launch - so an
   * unrelated service that grabs the port is handed nothing and the app-owned
   * backend keeps serving.
   */
  private async maybeHandBack(): Promise<void> {
    if (this.pausedForUpdate) return;
    if (this.quitting || this.attached || !this.owned) return;
    if (!this.externalExpected || this.handBackRunning) return;
    const config = this.deps.config();
    if (this.port() === config.port) return;
    const nodePath = this.runtime?.nodePath ?? null;
    if (nodePath === null) return;
    this.handBackRunning = true;
    try {
      if ((await this.deps.probePort(config.port)) !== 'occupied') return;
      if (!(await this.isLauncherOn(config.port, nodePath))) return;
      // Only hand the port back when this profile's session really works there:
      // a verified listener that rejects it would leave the owner without a
      // WebUI once the fallback backend is gone.
      if (!(await this.answersThisProfile(config.port))) return;
      this.deps.log.info(
        `the backend started outside this app is serving port ${config.port} again; handing the port back`,
      );
      await this.serial(async () => {
        if (this.quitting || this.attached) return;
        this.attempt = 0;
        this.setState('RECOVERING', 'Connecting to the backend started outside this app');
        await this.stopOwnedServer();
        await this.bringUp();
      });
    } catch (error) {
      // bringUp reports its own failures; this branch only catches the stop, so
      // the state has to be made terminal here or recovery would never run again.
      const detail = describe(error);
      this.deps.log.error(`handing the port back failed: ${detail}`);
      this.fail(
        error instanceof ShellError
          ? error
          : new ShellError('unexpected', detail, 'See the log for details.'),
      );
    } finally {
      this.handBackRunning = false;
    }
  }

  /** Does the WebUI on `port` accept this profile's stored session? */
  private async answersThisProfile(port: number): Promise<boolean> {
    try {
      return (await this.deps.web.health(buildOrigin(port))) === 200;
    } catch (error) {
      this.deps.log.debug(`session probe on port ${port} failed: ${describe(error)}`);
      return false;
    }
  }

  /** Is a verified `dsh web` launch of this profile listening on `port`? */
  private async isLauncherOn(port: number, nodePath: string | null): Promise<boolean> {
    if (nodePath === null) return false;
    try {
      const pid = await this.deps.wsl.findPortOwner(this.distro(), port, nodePath);
      if (pid === null) return false;
      const probe = await this.deps.wsl.probeProcess(this.distro(), pid);
      return verifyOwnership(probe, { port }) === 'owned';
    } catch (error) {
      this.deps.log.debug(`launcher probe failed: ${describe(error)}`);
      return false;
    }
  }

  /**
   * Does this profile expect the fixed port to belong to a backend the owner
   * runs? A record written for another distribution or port describes old user
   * intent and is dropped instead of blocking the current settings.
   */
  private expectExternalBackend(): boolean {
    const record = this.deps.external.read();
    if (record === null) return false;
    // Always compared against the configured port: an app-owned backend may
    // serve on a fallback port beside it, which is not the launcher's port.
    if (record.distro !== this.distro() || record.port !== this.deps.config().port) {
      this.deps.log.debug('dropping an external-backend expectation written for other settings');
      this.deps.external.clear();
      return false;
    }
    return true;
  }

  private recordExternalExpectation(misses = 0): void {
    try {
      this.deps.external.write({
        distro: this.distro(),
        // The launcher's port, never the fallback port the app may serve on.
        port: this.deps.config().port,
        recordedAt: new Date(this.deps.now()).toISOString(),
        ...(misses > 0 ? { misses } : {}),
      });
    } catch (error) {
      // A read-only or full profile must not turn a verified attach into a
      // failure, nor stop the fallback backend from starting.
      this.deps.log.warn(`could not record the external-backend expectation: ${describe(error)}`);
    }
  }

  private clearExternalExpectation(): void {
    this.externalExpected = false;
    this.deps.external.clear();
  }

  /**
   * Short cold-start discovery: is a verified external backend about to take
   * the free port? Attaches when one appears within the grace window and
   * returns `false` when the app should start its own. A listener that answers
   * but fails the checks is reported as a collision instead of being ignored.
   */
  private async discoverExternal(nodePath: string | null): Promise<boolean> {
    const graceMs = this.deps.discoveryGraceMs ?? 0;
    if (graceMs <= 0) return false;
    const pollMs = Math.max(1, this.deps.discoveryPollMs ?? 500);
    // The attempt cap keeps the loop bounded even when the clock does not move
    // (test doubles with an instant sleep), the deadline keeps it inside the
    // window when it does.
    const maxAttempts = Math.max(1, Math.ceil(graceMs / pollMs));
    // The deadline covers the attach attempts too: a verified backend that is
    // still starting already spends about a second per attempt in its session
    // check, so counting sleeps alone would overrun the window.
    const deadline = this.deps.now() + graceMs;
    for (let attempt = 0; ; attempt += 1) {
      if (this.quitting) return false;
      if (attempt === 0) this.deps.log.info(`cold start: waiting ${graceMs} ms for a backend started outside this app`);
      const state = await this.deps.probePort(this.port());
      if (state === 'occupied') {
        const attach = await this.tryAttachExternal(nodePath);
        if (attach === 'attached') {
          this.deps.log.info('attached to the backend that started during the cold-start window');
          return true;
        }
        if (attach === 'not-ours') {
          throw new ShellError(
            'port-collision',
            `Port ${this.port()} is already in use by a service this app does not own.`,
            'Close the other service or choose another port in Settings. The app never connects to unknown listeners.',
          );
        }
        // A verified DSH backend that cannot answer the session check yet is
        // most likely still starting: keep the window open instead of starting
        // a competitor over it.
      }
      const remaining = deadline - this.deps.now();
      if (remaining <= 0 || attempt >= maxAttempts) {
        // A listener that is only verified but never ready is not a stranger,
        // so it must not be raced for the port.
        if (state === 'occupied') {
          throw new ShellError(
            'port-collision',
            `Port ${this.port()} is already in use by a service this app does not own.`,
            'A DSH backend started outside this app holds the port, and this app profile has never authenticated against it, so it cannot be trusted yet. Stop it and let the app start its own backend, or choose another port in Settings.',
          );
        }
        return false;
      }
      await this.deps.sleep(Math.min(pollMs, remaining));
    }
  }

  /**
   * Wait, bounded, for the backend the owner started on the fixed port and
   * attach to it. Never spawns a replacement: `absent` means nothing took the
   * port in the wait window, `rejected` means a listener answered but failed
   * the ownership or session checks.
   */
  private async awaitExternal(nodePath: string | null): Promise<'attached' | 'absent' | 'rejected'> {
    const waitMs = this.attachWaitMs();
    const pollMs = this.attachPollMs();
    const maxAttempts = Math.max(1, Math.ceil(waitMs / pollMs));
    const deadline = this.deps.now() + waitMs;
    this.deps.log.info(`waiting up to ${waitMs} ms for the backend started outside this app`);
    for (let attempt = 0; ; attempt += 1) {
      if (this.quitting) return 'absent';
      if (attempt > 0 && this.lifecycle.state !== 'CONNECTING') {
        this.setState('CONNECTING', 'Waiting for the DeepSeek Harness started outside this app');
      }
      const state = await this.deps.probePort(this.port());
      if (state === 'occupied') {
        const attach = await this.tryAttachExternal(nodePath);
        if (attach === 'attached') return 'attached';
        if (attach === 'not-ours') {
          this.deps.log.warn(`the listener on port ${this.port()} is not this profile's backend`);
          return 'rejected';
        }
      }
      const remaining = deadline - this.deps.now();
      if (remaining <= 0 || attempt >= maxAttempts) {
        if (state === 'occupied') {
          this.deps.log.warn(`the backend on port ${this.port()} never accepted this profile's session`);
          return 'rejected';
        }
        return 'absent';
      }
      await this.deps.sleep(Math.min(pollMs, remaining));
    }
  }

  /**
   * Connect to a DSH backend the app does not own.
   *
   * The owner may run `dsh web` themselves, for example a systemd unit that
   * starts it at every boot. Refusing forever would leave the app unusable after
   * each reboot, so an unrecorded listener is accepted only when two independent
   * checks pass: its command line is our own `dsh web --host 127.0.0.1 --port
   * <port>` launch (the PID comes from the distribution, never from the port
   * answer), and the stored session cookie authenticates against it. The process
   * stays outside the app's lifecycle: it is never signalled or restarted.
   */
  private async tryAttachExternal(nodePath: string | null): Promise<'attached' | 'no-session' | 'not-ours'> {
    if (nodePath === null) return 'not-ours';
    try {
      const pid = await this.deps.wsl.findPortOwner(this.distro(), this.port(), nodePath);
      if (pid === null) return 'not-ours';
      const probe = await this.deps.wsl.probeProcess(this.distro(), pid);
      if (verifyOwnership(probe, { port: this.port() }) !== 'owned') {
        this.deps.log.debug(`no attach: listener pid ${pid} is not an app-compatible dsh launch`);
        return 'not-ours';
      }
      this.setState('CONNECTING', 'Connecting to the running DeepSeek Harness');
      if (!(await this.tryExistingSession())) {
        this.deps.log.debug('no attach: the stored session cookie was rejected by the running backend');
        return 'no-session';
      }
      this.attached = true;
      this.attachedPid = pid;
      this.owned = false;
      this.serverPid = null;
      this.serverStartTime = null;
      this.externalExpected = true;
      this.recordExternalExpectation();
      this.deps.log.info(`attached to the running backend (pid=${pid}); it stays outside the app lifecycle`);
      // Learn which manager owns it right away: the update window asks whether
      // that backend may be stopped long before the owner presses Update.
      return 'attached';
    } catch (error) {
      this.deps.log.warn(`attach probe failed: ${describe(error)}`);
      return 'not-ours';
    }
  }

  private async verifyRecordedServer(): Promise<{ verdict: 'owned' | 'foreign' | 'gone'; record: OwnedServerRecord | null }> {
    const record = this.deps.registry.read();
    if (record === null) return { verdict: 'gone', record: null };
    if (record.distro !== this.distro() || record.port !== this.port()) {
      // A record for a fallback port beside the configured one is not this
      // port's proof, but it may still describe a live app-owned backend whose
      // probe just failed. Start decides its fate and keeps or drops it.
      if (!isFallbackPort(record.port, this.port())) this.deps.registry.clear();
      return { verdict: 'gone', record: null };
    }
    const probe = await this.deps.wsl.probeProcess(this.distro(), record.pid);
    const verdict = verifyOwnership(probe, { port: this.port(), startTime: record.startTime });
    // Only a definite mismatch proves the record wrong. A `gone` verdict also
    // covers a failed or timed-out probe, which must not destroy the record for
    // a backend that is in fact alive (a later start can still adopt it).
    if (verdict === 'foreign') this.deps.registry.clear();
    return { verdict, record };
  }

  /**
   * Resolve a backend this app started before a new start/recovery.
   *
   * Ownership is verified first: a live app-owned process is stopped with
   * TERM/KILL, a vanished one is simply forgotten, and a PID that no longer
   * matches the recorded start time is left untouched.
   */
  private async releaseOwnedProcess(): Promise<void> {
    if (!this.owned && this.serverPid === null && this.server === null) return;
    await this.stopOwnedServer();
  }

  /**
   * Graceful, ownership-checked termination of the backend this app started.
   *
   * Identity is verified three times: before TERM, before the escalated KILL
   * (so a recycled PID is never targeted) and, for the KILL, once more as
   * close to the signal as possible.
   */
  private async stopOwnedServer(): Promise<void> {
    if (this.attached) {
      // The attached process belongs to the owner's own launcher. Stopping it
      // would take down something the app never started.
      this.deps.log.debug('stop skipped: the app is attached to an external backend');
      return;
    }
    const pid = this.serverPid;
    const startTime = this.serverStartTime;
    // The ownership proof names the port the process was launched with, which is
    // not necessarily the configured one: while the launcher's port is reserved
    // the app serves on a fallback port, and a later start has already moved
    // `activePort` back before this runs. Verifying against `this.port()` here
    // would read the live fallback backend as foreign and leave it behind.
    const recorded = this.deps.registry.read();
    const launchedPort =
      recorded !== null && recorded.pid === pid && recorded.distro === this.distro()
        ? recorded.port
        : this.port();
    const expectation = { port: launchedPort, startTime };

    if (pid !== null) {
      const probe = await this.deps.wsl.probeProcess(this.distro(), pid);
      const verdict = verifyOwnership(probe, expectation);
      if (verdict === 'owned') {
        this.deps.log.info(`stopping owned backend pid=${pid}`);
        await this.deps.wsl.signal(this.distro(), pid, 'TERM').catch(() => undefined);

        const graceMs = this.deps.stopGraceMs ?? 5_000;
        const deadline = this.deps.now() + graceMs;
        let check = await this.deps.wsl.probeProcess(this.distro(), pid);
        while (check !== null && this.deps.now() < deadline) {
          await this.deps.sleep(200);
          check = await this.deps.wsl.probeProcess(this.distro(), pid);
        }

        // Revalidate the full identity (PID + start time + command line) right
        // before escalating: the PID may have been recycled while we waited.
        const finalProbe = check === null ? null : await this.deps.wsl.probeProcess(this.distro(), pid);
        const finalVerdict = verifyOwnership(finalProbe, expectation);
        if (finalVerdict === 'owned') {
          const confirmed = await this.deps.wsl.probeProcess(this.distro(), pid);
          if (verifyOwnership(confirmed, expectation) === 'owned') {
            this.deps.log.warn(`backend pid=${pid} ignored SIGTERM; sending SIGKILL`);
            await this.deps.wsl.signal(this.distro(), pid, 'KILL').catch(() => undefined);
          } else {
            this.deps.log.warn(`pid=${pid} no longer matches the owned backend; SIGKILL withheld`);
          }
        } else if (finalVerdict === 'foreign') {
          this.deps.log.warn(`pid=${pid} no longer matches the owned backend; leaving it alone`);
        }
      } else if (verdict === 'foreign') {
        this.deps.log.warn(`pid=${pid} no longer matches the owned backend; leaving it alone`);
      }
    } else if (this.server !== null) {
      // Spawned but no PID was observed yet: only the launcher handle exists.
      this.deps.log.warn('stopping backend launcher without a known pid');
    }

    if (this.server !== null) {
      await this.server.stop().catch(() => undefined);
    }
    if (pid !== null) {
      // Drop the record only when it describes the process handled here. A
      // failed replacement attempt must never erase the ownership proof for a
      // different, still running backend.
      const current = this.deps.registry.read();
      if (current === null || current.pid === pid) this.deps.registry.clear();
    }
    this.server = null;
    this.serverPid = null;
    this.serverStartTime = null;
    this.owned = false;
  }

  /**
   * Exit without touching the backend.
   *
   * The app-owned backend is a service of the WSL distribution, not of the app
   * window: closing the app leaves `dsh web` and its launcher running. The
   * registry record is kept on purpose, so the next start proves ownership and
   * adopts the same process instead of spawning a second one. Only an explicit
   * Restart WebUI, an update swap or a settings change that requires a restart
   * may stop it; the distribution itself is never torn down by this app.
   */
  async detach(): Promise<void> {
    if (this.quitting) return;
    this.quitting = true;
    this.lifecycle.forceQuit();
    this.status = this.buildStatus('QUITTING', null);
    this.deps.publish(this.status);
    this.deps.log.info('backend left running: its lifetime follows the WSL distribution, not the app window');
    // Deliberately no stopOwnedServer(): `server`, `serverPid`, `serverStartTime`
    // and the registry record stay intact for the next start to verify and adopt.
  }

  /** Fully serialized shutdown; stops only the process this app owns. */
  async shutdown(): Promise<void> {
    if (this.quitting) return;
    this.quitting = true;
    this.lifecycle.forceQuit();
    this.status = this.buildStatus('QUITTING', null);
    this.deps.publish(this.status);
    await this.serial(async () => {
      await this.stopOwnedServer();
    });
  }

  private fail(error: ShellError): void {
    const message = error.hint === null ? error.message : `${error.message} ${error.hint}`;
    this.deps.log.error(`terminal: ${message}`);
    if (this.lifecycle.state === 'QUITTING' || this.quitting) return;
    try {
      this.setState('ERROR', message);
    } catch {
      this.detail = message;
      this.status = this.buildStatus('ERROR', message);
      this.deps.publish(this.status);
    }
  }

  private setDetail(detail: string): void {
    this.detail = detail;
    this.status = this.buildStatus(this.lifecycle.state, detail);
    this.deps.publish(this.status);
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: ShellErrorCode, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ShellError(code, message, 'See the log for details.')), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
