import type {
  ExitInfo,
  NpmVersionCheck,
  ResolvedRuntime,
  ServerHandle,
  StartServerRequest,
  UpdateRunRequest,
  UpdateRunResult,
  UpdateRestoreRequest,
  WslGateway,
} from '../src/main/core/supervisor.js';
import type { ProcessProbe } from '../src/main/wsl/output.js';
import type { RuntimeObservation } from '../src/main/core/update.js';
import type { WebClient } from '../src/main/core/supervisor.js';
import { createMemoryRegistry } from '../src/main/core/registry.js';
import { createNullLogger } from '../src/main/core/logger.js';
import { DEFAULT_CONFIG, type AppConfig, type ShellStatus } from '../src/shared/types.js';

export const BACKEND_PID = 4242;
export type PortState = 'free' | 'occupied';
export const BACKEND_START_TIME = '918273';
export const PORT = 3080;

export function backendProbe(overrides: Partial<ProcessProbe> & { port?: number } = {}): ProcessProbe {
  const port = overrides.port ?? PORT;
  const cmdline =
    `/usr/bin/node /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js web --host 127.0.0.1 --port ${port} --no-open`;
  const finalCmdline = overrides.cmdline ?? cmdline;
  return {
    startTime: overrides.startTime ?? BACKEND_START_TIME,
    cmdline: finalCmdline,
    argv: finalCmdline.split(' '),
  };
}

export class FakeServer implements ServerHandle {
  readonly pid: Promise<number | null>;
  private readonly listeners = new Set<(line: string) => void>();
  private readonly collected: string[] = [];
  private readonly exitResolvers: ((info: ExitInfo) => void)[] = [];
  stopCalls = 0;
  readonly exited: Promise<ExitInfo>;

  constructor(
    private readonly options: {
      pid?: number | null;
      announceUrl?: boolean;
      urlPort?: number;
      stderr?: string;
    } = {},
  ) {
    this.pid = Promise.resolve(options.pid === undefined ? BACKEND_PID : options.pid);
    this.exited = new Promise<ExitInfo>((resolve) => this.exitResolvers.push(resolve));
  }

  emit(line: string): void {
    this.collected.push(line);
    for (const listener of this.listeners) listener(line);
  }

  announce(): void {
    if (this.options.announceUrl === false) return;
    this.emit(`dsh web: http://127.0.0.1:${this.options.urlPort ?? PORT}/?token=test-token-0123456789abcdef`);
  }

  exit(info: ExitInfo = { code: 1, signal: null }): void {
    for (const resolve of this.exitResolvers) resolve(info);
  }

  lines(): string[] {
    return [...this.collected];
  }

  onLine(listener: (line: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  stderrTail(): string {
    return this.options.stderr ?? 'stderr tail';
  }
}

export interface FakeWslOptions {
  distros?: string[];
  probe?: (pid: number) => ProcessProbe | null;
  pid?: number | null;
  urlPort?: number;
  announceUrl?: boolean;
  dshPath?: string;
  nodePath?: string | null;
  failResolve?: 'dsh-missing' | null;
  failPrepare?: boolean;
  /** Simulate a backend that dies before announcing its WebUI URL. */
  exitBeforeReady?: { code: number | null; stderr?: string };
}

export class FakeWsl implements WslGateway {
  readonly starts: StartServerRequest[] = [];
  readonly signals: { pid: number; signal: 'TERM' | 'KILL' }[] = [];
  readonly servers: FakeServer[] = [];
  distroProbes = 0;
  private readAttempts = 0;

  constructor(public options: FakeWslOptions = {}) {}

  async listDistros(): Promise<string[]> {
    return this.options.distros ?? ['Ubuntu'];
  }

  async ensureDistro(): Promise<void> {
    this.distroProbes += 1;
  }

  /** Version queried from the selected executable (issue #9 footer). */
  dshVersionValue: string | null = '0.2.1-rc.5';
  readonly versionQueries: { distro: string; dshPath: string; nodePath: string | null }[] = [];

  /** Update-related fake state (issue #12). */
  npmCheckResult: NpmVersionCheck = { found: true, npmPath: '/usr/bin/npm', reported: '0.2.2-rc.1', message: null };
  /** Per-step exit codes: staged install, activation, restore. */
  stageCode: number | null = 0;
  activateCode: number | null = 0;
  restoreCode: number | null = 0;
  updateRunLines: string[] = ['update: verifying the staged installation', 'update: staged version 0.2.2-rc.1'];
  /** What `inspectRuntime` reports (journal recovery tests). */
  runtimeObservation: RuntimeObservation = {
    runtimePresent: true,
    runtimeVersion: '0.2.1-rc.5',
    previous: null,
    stage: null,
  };
  readonly stageRuns: UpdateRunRequest[] = [];
  readonly activateRuns: UpdateRunRequest[] = [];
  readonly restoreRuns: UpdateRestoreRequest[] = [];
  readonly npmChecks: { distro: string; isolationRoot: string; version: string; nodePath: string | null }[] = [];

  async checkPublishedVersion(request: {
    distro: string;
    isolationRoot: string;
    version: string;
    nodePath: string | null;
  }): Promise<NpmVersionCheck> {
    this.npmChecks.push(request);
    return { ...this.npmCheckResult, reported: this.npmCheckResult.reported ?? request.version };
  }

  async stageRuntime(request: UpdateRunRequest, onLine: (line: string) => void): Promise<UpdateRunResult> {
    this.stageRuns.push(request);
    for (const line of this.updateRunLines) onLine(line);
    return { code: this.stageCode, tail: this.updateRunLines.slice(-2).join(' ') };
  }

  async activateRuntime(request: UpdateRunRequest, onLine: (line: string) => void): Promise<UpdateRunResult> {
    this.activateRuns.push(request);
    onLine('update: activating');
    return { code: this.activateCode, tail: this.activateCode === 0 ? 'update: installed version 0.2.2-rc.1' : 'update: activation failed' };
  }

  async restoreRuntime(request: UpdateRestoreRequest, onLine: (line: string) => void): Promise<UpdateRunResult> {
    this.restoreRuns.push(request);
    onLine('update: restoring the previous installation');
    return { code: this.restoreCode, tail: this.restoreCode === 0 ? 'update: rollout reverted' : 'update: nothing to restore' };
  }

  async inspectRuntime(): Promise<RuntimeObservation> {
    return { ...this.runtimeObservation };
  }

  async dshVersion(distro: string, dshPath: string, nodePath: string | null = null): Promise<string | null> {
    this.versionQueries.push({ distro, dshPath, nodePath });
    return this.dshVersionValue;
  }

  readonly isolationPreparations: string[] = [];
  readonly runtimeQueries: { isolationRoot: string | null; override: string | null }[] = [];

  async prepareIsolation(_distro: string, root: string): Promise<void> {
    this.isolationPreparations.push(root);
    if (this.options.failPrepare === true) {
      const error = new Error('isolation prepare failed');
      error.name = 'ShellError';
      throw error;
    }
  }

  async resolveRuntime(
    _distro: string,
    override: string | null,
    isolationRoot: string | null,
  ): Promise<ResolvedRuntime> {
    this.runtimeQueries.push({ isolationRoot, override });
    if (this.options.failResolve === 'dsh-missing') {
      const error = new Error('dsh missing');
      error.name = 'ShellError';
      throw error;
    }
    return {
      dshPath: override ?? this.options.dshPath ?? '/usr/local/bin/dsh',
      nodePath: this.options.nodePath === undefined ? '/usr/bin/node' : this.options.nodePath,
    };
  }

  startHook: (() => void) | null = null;

  startServer(request: StartServerRequest): ServerHandle {
    this.starts.push(request);
    this.startHook?.();
    const exitBeforeReady = this.options.exitBeforeReady;
    const server = new FakeServer({
      pid: this.options.pid === undefined ? BACKEND_PID : this.options.pid,
      urlPort: this.options.urlPort ?? request.port,
      announceUrl: exitBeforeReady === undefined ? this.options.announceUrl : false,
      stderr: exitBeforeReady?.stderr,
    });
    this.servers.push(server);
    // Announce asynchronously, like the real process would.
    queueMicrotask(() => {
      if (exitBeforeReady !== undefined) {
        server.exit({ code: exitBeforeReady.code, signal: null });
        return;
      }
      server.announce();
    });
    return server;
  }

  async probeProcess(_distro: string, pid: number): Promise<ProcessProbe | null> {
    this.readAttempts += 1;
    if (this.options.probe !== undefined) return this.options.probe(pid);
    return pid === BACKEND_PID ? backendProbe() : null;
  }

  signalHook: ((pid: number, signal: 'TERM' | 'KILL') => void) | null = null;

  async signal(_distro: string, pid: number, signal: 'TERM' | 'KILL'): Promise<void> {
    this.signals.push({ pid, signal });
    this.signalHook?.(pid, signal);
  }

  get probeCalls(): number {
    return this.readAttempts;
  }
}

export class FakeWeb implements WebClient {
  bootstraps: string[] = [];
  healthCalls = 0;

  constructor(
    private readonly options: {
      bootstrapStatus?: number;
      health?: () => number;
    } = {},
  ) {}

  async bootstrapToken(_tokenUrl: string): Promise<number> {
    this.bootstraps.push(_tokenUrl);
    return this.options.bootstrapStatus ?? 200;
  }

  async health(): Promise<number> {
    this.healthCalls += 1;
    return this.options.health === undefined ? 200 : this.options.health();
  }
}

export interface HarnessOptions {
  config?: Partial<AppConfig>;
  wsl?: FakeWslOptions;
  web?: { bootstrapStatus?: number; health?: () => number };
  portState?: PortState | (() => PortState);
  registry?: ReturnType<typeof createMemoryRegistry>;
}

export function createHarness(options: HarnessOptions = {}) {
  const config: AppConfig = { ...DEFAULT_CONFIG, ...options.config };
  const statuses: ShellStatus[] = [];
  const wsl = new FakeWsl(options.wsl);
  const web = new FakeWeb(options.web);
  const registry = options.registry ?? createMemoryRegistry();
  const probeCalls: number[] = [];
  return {
    config,
    wsl,
    web,
    registry,
    statuses,
    probeCalls,
    deps: {
      config: () => config,
      wsl,
      web,
      registry,
      log: createNullLogger(),
      probePort: async (port: number) => {
        probeCalls.push(port);
        const state = options.portState ?? 'free';
        return typeof state === 'function' ? state() : state;
      },
      sleep: async (_ms: number) => undefined,
      now: () => Date.now(),
      publish: (status: ShellStatus) => statuses.push(status),
      appVersion: '0.0.0-test',
      logPath: () => '/tmp/app.log',
      startupTimeoutMs: 2_000,
      healthAttempts: 2,
      stopGraceMs: 0,
    },
  };
}

export function lastStatus(statuses: ShellStatus[]): ShellStatus {
  const status = statuses.at(-1);
  if (status === undefined) throw new Error('no status published');
  return status;
}

