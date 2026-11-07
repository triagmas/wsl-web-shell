/**
 * Electron main entry point.
 *
 * Owns the single-instance lock, the supervisor lifetime, the tray, the
 * sandboxed backend window and the local splash/settings surfaces.
 */
import { app, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { applyConfigPatch, requiresRestart } from './core/config.js';
import {
  CLEAN_SHUTDOWN_MARKER,
  describeChildProcessGone,
  describeError,
  describeWindowEvent,
  summarizePreviousSession,
} from './core/diagnostics.js';
import { createLatestVersionService } from './backend/github-versions.js';
import { createUpdateRunner } from './core/update-runner.js';
import { createJournalStore, recoverInterruptedUpdate } from './core/update-recovery.js';
import { describeRelaunchFailure, resolveRelaunchTarget } from './core/relaunch.js';
import {
  UPDATE_REASONS,
  createTransactionId,
  describeUpdatePhase,
  describeUpdateReason,
  isUpdateCritical,
  planUpdate,
  type UpdatePlan,
} from './core/update.js';
import { createLogger } from './core/logger.js';
import { isNewer } from './core/versions.js';
import { parsePopoverAnchor } from './core/footer.js';
import { probePort } from './core/port.js';
import { createFileRegistry } from './core/registry.js';
import { ShellError, Supervisor } from './core/supervisor.js';
import { buildOrigin } from './backend/urls.js';
import { createWslGateway } from './wsl/gateway.js';
import { decideReadyVisibility, decideTrayOpen, shouldActivateSplash } from './core/visibility.js';
import { createConfigStore } from './electron/config-store.js';
import { createWebClient } from './electron/web-client.js';
import { TrayController } from './electron/tray.js';
import { Windows } from './electron/windows.js';
import type {
  AppConfig,
  ConfigPatch,
  ShellStatus,
  UpdateProbe,
  UpdateStartResult,
  VersionSnapshot,
} from '../shared/types.js';

const APP_ID = 'com.triagmas.wslwebshell';

/**
 * Packaged relaunch self-test (issue #12).
 *
 * The only way to prove that an update restarts the *portable* EXE — and not the
 * temporary extraction copy — is to run the packaged build itself:
 *
 *   WSL-Web-Shell-0.1.0-x64.exe --relaunch-probe=<dir>
 *
 * The parent records where it runs, decides the relaunch target with the same
 * `resolveRelaunchTarget()` the update uses, relaunches it through `app.relaunch`
 * with `--relaunch-child`, and exits. The child records the executable it was
 * started from. The Windows CI job compares both records; nothing here runs
 * during a normal start.
 */
const RELAUNCH_PROBE_PREFIX = '--relaunch-probe=';
const RELAUNCH_CHILD_FLAG = '--relaunch-child';

async function runRelaunchProbe(directory: string): Promise<void> {
  const phase = process.argv.includes(RELAUNCH_CHILD_FLAG) ? 'child' : 'parent';
  const record = {
    phase,
    execPath: process.execPath,
    portable: process.env.PORTABLE_EXECUTABLE_FILE ?? null,
    pid: process.pid,
  };
  const write = (name: string, payload: unknown): void => {
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, name), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    } catch {
      // A probe that cannot write its own marker fails the CI comparison.
    }
  };
  write(`${phase}.json`, record);
  if (phase === 'child') {
    app.exit(0);
    return;
  }
  const decision = resolveRelaunchTarget(
    {
      portableExecutableFile: process.env.PORTABLE_EXECUTABLE_FILE ?? null,
      execPath: process.execPath,
      platform: process.platform,
    },
    (path) => {
      try {
        return existsSync(path);
      } catch {
        return false;
      }
    },
  );
  write('decision.json', decision);
  if (!decision.ok) {
    app.exit(3);
    return;
  }
  app.relaunch({
    execPath: decision.target.execPath,
    args: [`${RELAUNCH_PROBE_PREFIX}${directory}`, RELAUNCH_CHILD_FLAG],
  });
  app.exit(0);
}

const relaunchProbeArg = process.argv.find((argument) => argument.startsWith(RELAUNCH_PROBE_PREFIX));

if (relaunchProbeArg !== undefined) {
  // Runs before the single-instance lock: the parent and the relaunched child
  // would otherwise fight over it.
  void runRelaunchProbe(relaunchProbeArg.slice(RELAUNCH_PROBE_PREFIX.length)).catch(() => app.exit(1));
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void bootstrap().catch((error: unknown) => {
    // A failure before the logger exists must still be visible and fatal.
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    process.stderr.write(`wsl-web-shell: fatal startup error: ${message}\n`);
    app.exit(1);
  });
}

async function bootstrap(): Promise<void> {
  app.setAppUserModelId(APP_ID);

  const userData = app.getPath('userData');
  const logPath = join(userData, 'logs', 'app.log');
  const log = createLogger(logPath);
  // Read the tail before this run writes anything: it is the previous run's
  // last words. A missing shutdown marker means it did not exit through the
  // app's own quit path (external kill, power loss, native fault).
  const previousSession = summarizePreviousSession(log.tail(10).split('\n'));
  log.info(`wsl-web-shell ${app.getVersion()} starting (pid=${process.pid})`);
  if (previousSession.lastEvent !== '') {
    log.info(
      previousSession.clean
        ? `previous session: clean shutdown (last event: ${previousSession.lastEvent})`
        : `previous session: ended without a clean shutdown (last event: ${previousSession.lastEvent})`,
    );
  }

  /**
   * Fatal main-process faults used to end the app silently. The outcome stays
   * fatal on purpose; only the cause is now recorded (message only — never a
   * stack, a token or a user path).
   */
  const reportFatal = (kind: string, error: unknown): void => {
    log.error(`${kind}: ${describeError(error)}`);
    process.exit(1);
  };
  process.on('uncaughtException', (error: unknown) => reportFatal('uncaught exception', error));
  process.on('unhandledRejection', (reason: unknown) => reportFatal('unhandled rejection', reason));
  app.on('child-process-gone', (_event, details) => {
    log.error(describeChildProcessGone(details));
  });
  app.on('quit', (_event, exitCode) => {
    log.info(`app quit (exit code=${exitCode})`);
  });

  // Windows announces logoff/shutdown on the window before closing it: without
  // this flag an OS-initiated close would look like the user clicking X.
  let sessionEnding = false;

  const versions = createLatestVersionService({
    cachePath: join(userData, 'versions-cache.json'),
    log,
  });
  const configStore = createConfigStore(join(userData, 'config.json'));
  let config: AppConfig = configStore.load();
  const registry = createFileRegistry(join(userData, 'owned-server.json'));
  const rendererDir = join(__dirname, '..');
  const preloadDir = join(__dirname, '..', 'preload');

  // Origin of the running backend; updated from every status snapshot so the
  // navigation guard always matches the page that is actually loaded.
  let activePort = config.port;
  // Whether the user was ever shown a window in this session; afterwards the
  // visibility choice belongs to the user, not to the startup setting.
  let everShown = false;
  let loadedGeneration: number | null = null;

  const windows: Windows = new Windows({
    rendererDir,
    preloadDir,
    log,
    origin: () => buildOrigin(activePort),
    devToolsEnabled: !app.isPackaged || process.env.WSL_WEB_SHELL_DEVTOOLS === '1',
    onRendererGone: () => {
      log.warn('renderer process gone; health supervisor will decide on recovery');
    },
    onExternalLink: (url: string) => {
      windows.openExternal(url);
    },
    onVisibilityChanged: (visible: boolean) => {
      if (visible) everShown = true;
      supervisor.markHidden(!visible);
      // The splash is an overlay of this window: it leaves with it.
      if (!visible) windows.hideSplash();
      tray?.update(supervisor.getStatus(), visible);
    },
    onWindowEvent: (context) => {
      if (context.event === 'session-end') {
        sessionEnding = true;
        log.info('system session end announced');
        return;
      }
      log.info(describeWindowEvent({ ...context, quitting, sessionEnding }));
    },
  });

  // Electron sessions only exist after `app.whenReady()`, so the session is
  // resolved lazily and configured in `whenReady` below.
  const web = createWebClient(() => windows.configureSession(), log);
  const wsl = createWslGateway({ log });

  /** Footer payload; installed comes from the running status, upstream from cache. */
  function versionSnapshot(): VersionSnapshot {
    const cache = versions.snapshot();
    const installed = supervisor.getStatus().dshVersion;
    return {
      installed,
      latest: cache.latest,
      checkedAt: cache.checkedAt,
      error: cache.error,
      updateAvailable: cache.latest !== null && isNewer(cache.latest.version, installed),
    };
  }

  let tray: TrayController | null = null;
  let healthTimer: NodeJS.Timeout | null = null;
  let quitting = false;

  const updateJournal = createJournalStore(join(userData, 'update-journal.json'), log);

  /**
   * What the confirmation window may do (issue #12).
   *
   * The plan is computed here, from the live configuration and the executable
   * the launcher really resolved, so a stale renderer can never talk the app
   * into replacing a global installation.
   */
  function resolveUpdatePlan() {
    const target = versions.snapshot().latest?.version ?? null;
    if (target === null) return { ok: false, reason: UPDATE_REASONS.unknownTarget } as const;
    const status = supervisor.getStatus();
    return planUpdate({
      distro: config.distro,
      targetVersion: target,
      installedVersion: status.dshVersion,
      resolvedDshPath: status.dshPath,
      canonicalRuntimeRoot: supervisor.resolvedRuntime()?.canonicalRoot ?? null,
      isolationEnabled: config.isolateEnvironment,
      runtimeRoot: config.runtimeRoot,
      customExecutable: config.dshPath !== null,
    });
  }

  function updateProbe(): UpdateProbe {
    const status = supervisor.getStatus();
    const result = resolveUpdatePlan();
    const base = {
      installed: status.dshVersion,
      target: versions.snapshot().latest?.version ?? null,
      distro: config.distro,
      runtimeRoot: config.runtimeRoot,
      running: updateRunner.running(),
    };
    if (!result.ok) {
      return {
        ...base,
        eligible: false,
        reason: result.reason,
        description: describeUpdateReason(result.reason),
        rollbackPath: null,
      };
    }
    return {
      ...base,
      installed: result.plan.installedVersion,
      target: result.plan.version,
      runtimeRoot: result.plan.runtimeDir,
      eligible: !updateRunner.running(),
      reason: null,
      description: null,
      rollbackPath: result.plan.previousPattern,
    };
  }

  /**
   * Restart the portable application after a successful update.
   *
   * The graceful path is the same as Quit (owned backend stopped, windows
   * destroyed, clean-shutdown marker written); only the final step differs:
   * relaunch the portable executable instead of exiting.
   *
   * A portable build runs from a temporary extraction directory, so
   * `process.execPath` is not the file the user started. When the portable path
   * is unknown or gone, the app must not pretend to restart itself: the terminal
   * window says what to do instead and stays open.
   */
  const relaunchApp = (): void => {
    const decision = resolveRelaunchTarget(
      {
        portableExecutableFile: process.env.PORTABLE_EXECUTABLE_FILE ?? null,
        execPath: process.execPath,
        platform: process.platform,
      },
      (path) => {
        try {
          return existsSync(path);
        } catch {
          return false;
        }
      },
    );
    if (!decision.ok) {
      log.warn(`update: automatic relaunch is not possible (${decision.reason})`);
      windows.publishUpdate({
        ...updateRunner.snapshot(),
        phase: 'done',
        detail: describeRelaunchFailure(decision.reason),
      });
      return;
    }

    log.info(`update: relaunching ${decision.target.execPath}`);
    quitting = true;
    if (healthTimer !== null) clearTimeout(healthTimer);
    healthTimer = null;
    windows.setQuitting();
    tray?.destroy();
    tray = null;
    void supervisor
      .shutdown()
      .catch((error: unknown) => {
        log.error(`shutdown before relaunch failed: ${error instanceof Error ? error.message : 'unknown'}`);
      })
      .finally(() => {
        log.info(CLEAN_SHUTDOWN_MARKER);
        windows.destroyAll();
        app.relaunch({ execPath: decision.target.execPath, args: [] });
        app.exit(0);
      });
  };

  const supervisor: Supervisor = new Supervisor({
    config: () => config,
    wsl,
    web,
    registry,
    log,
    probePort,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    appVersion: app.getVersion(),
    logPath: () => logPath,
    publish: (status) => {
      activePort = status.port;
      windows.publishStatus(status);
      windows.publishVersions(versionSnapshot());
      tray?.update(status, windows.isMainVisible());
      onStatusChange(status);
    },
  });

  const updateRunner = createUpdateRunner({
    wsl,
    lifecycle: supervisor,
    journal: updateJournal,
    log,
    publish: (state) => windows.publishUpdate(state),
    now: () => new Date().toISOString(),
  });


  const onStatusChange = (status: ShellStatus): void => {
    switch (status.state) {
      case 'READY': {
        windows.closeSplash();
        // A new backend generation means the page behind the same URL is stale.
        const generation = supervisor.readyGeneration;
        const force = loadedGeneration !== null && loadedGeneration !== generation;
        loadedGeneration = generation;
        void windows
          .loadBackend(buildOrigin(status.port), { force })
          .catch((error: unknown) => {
            log.error(`loading WebUI failed: ${error instanceof Error ? error.name : 'error'}`);
          });
        const decision = decideReadyVisibility({
          openOnLaunch: config.openOnLaunch,
          everShown,
          visible: windows.isMainVisible(),
        });
        if (decision === 'show') windows.showMain();
        void versions
          .refreshIfStale()
          .then(() => windows.publishVersions(versionSnapshot()))
          .catch(() => undefined);
        break;
      }
      case 'RECOVERING':
      case 'ERROR':
        // Never steal focus with the always-on-top overlay while hidden.
        windows.showSplash({ activate: shouldActivateSplash(windows.isMainVisible()) });
        break;
      case 'HIDDEN_IN_TRAY':
        windows.closeSplash();
        break;
      case 'QUITTING':
        windows.closeSplash();
        break;
      default:
        break;
    }
    scheduleHealthChecks();
  };

  const scheduleHealthChecks = (): void => {
    if (healthTimer !== null) clearTimeout(healthTimer);
    healthTimer = null;
    if (quitting) return;
    const status = supervisor.getStatus();
    if (status.state !== 'READY' && status.state !== 'HIDDEN_IN_TRAY') return;
    const interval = status.state === 'READY' ? 10_000 : 25_000;
    healthTimer = setTimeout(() => {
      void supervisor.healthTick().finally(() => scheduleHealthChecks());
    }, interval);
    healthTimer.unref?.();
  };

  const quit = (): void => {
    if (quitting) return;
    const updatePhase = updateRunner.snapshot().phase;
    if (updateRunner.running() && isUpdateCritical(updatePhase)) {
      // The runtime is being replaced or restarted right now: quitting here would
      // leave the isolated root half-swapped and force a repair on the next start.
      log.warn(`quit refused: the update is ${updatePhase}`);
      windows.openUpdateProgress();
      windows.publishUpdate({
        ...updateRunner.snapshot(),
        detail: 'The runtime is being replaced right now. The app quits as soon as this step finished.',
      });
      return;
    }
    if (updateRunner.running()) {
      // Before the swap nothing but a staging directory changes, so quitting is
      // safe: the journal is abandoned on the next start.
      log.info(`quit during update staging (${updatePhase}); the staged install is not activated`);
    }
    quitting = true;
    log.info('quit requested');
    if (healthTimer !== null) clearTimeout(healthTimer);
    healthTimer = null;
    windows.setQuitting();
    tray?.destroy();
    tray = null;
    void supervisor
      .shutdown()
      .catch((error: unknown) => {
        log.error(`shutdown failed: ${error instanceof Error ? error.message : 'unknown'}`);
      })
      .finally(() => {
        // Marker read by the next start to separate a clean exit from a kill.
        log.info(CLEAN_SHUTDOWN_MARKER);
        windows.destroyAll();
        app.quit();
      });
  };

  const startTray = (): void => {
    if (tray !== null) return;
    tray = new TrayController({
      iconPath: join(rendererDir, 'assets', 'tray.png'),
      log: (message) => log.info(message),
      handlers: {
        open: () => {
          const state = supervisor.getStatus().state;
          if (decideTrayOpen(state) === 'overlay') {
            // Nothing loadable yet: bring the actionable overlay to the front.
            windows.showSplash({ activate: true });
            return;
          }
          windows.showMain();
          if (state === 'READY' || state === 'HIDDEN_IN_TRAY') {
            void supervisor.healthTick().catch(() => undefined);
          }
        },
        status: () => {
          const status = supervisor.getStatus();
          const lines = [
            `State: ${status.state}`,
            `Message: ${status.message}`,
            status.detail === null ? null : `Detail: ${status.detail}`,
            `Distribution: ${status.distro}`,
            `Port: ${status.port}`,
            `Backend managed by this app: ${status.ownedServer ? 'yes' : 'no'}`,
            `Log: ${logPath}`,
          ].filter((line): line is string => line !== null);
          void dialog.showMessageBox({
            type: status.state === 'ERROR' ? 'error' : 'info',
            title: 'WSL Web Shell — Connection status',
            message: status.message,
            detail: lines.join('\n'),
            buttons: ['OK'],
          });
        },
        restart: () => {
          const state = supervisor.getStatus().state;
          if (state === 'ERROR') void supervisor.retry().catch(() => undefined);
          else void supervisor.restart().catch(() => undefined);
        },
        settings: () => windows.openSettings(),
        quit,
      },
    });
    tray.create();
    tray.update(supervisor.getStatus(), false);
  };

  const isTrustedSender = (event: IpcMainInvokeEvent): boolean => {
    const url = event.senderFrame?.url ?? '';
    return url.startsWith('file://');
  };

  const guard = <T>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<T> | T,
  ): void => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!isTrustedSender(event)) {
        log.warn(`rejected ${channel} from untrusted sender`);
        throw new Error('untrusted-sender');
      }
      return await handler(event, ...args);
    });
  };

  guard('shell:status:get', () => supervisor.getStatus());

  // --- footer bar and settings popover -----------------------------------
  guard('footer:status', () => supervisor.getStatus());
  guard('footer:versions', () => versionSnapshot());
  guard('footer:toggle-settings', (_event, anchor) => {
    const parsed = parsePopoverAnchor(anchor);
    if (parsed === null) throw new Error('invalid-anchor');
    windows.toggleSettingsPopover(parsed);
  });
  guard('footer:open-release', () => {
    // Only the URL that came from the upstream lookup may be opened, and only
    // through the system browser (never inside the WebUI).
    const url = versions.snapshot().latest?.url ?? null;
    if (url !== null) windows.openExternal(url);
  });
  guard('popover:close', () => {
    windows.closeSettingsPopover();
  });

  // --- one-click update (issue #12) --------------------------------------
  guard('footer:open-update', () => {
    windows.closeSettingsPopover();
    windows.openUpdateConfirm();
  });
  guard('update:probe', () => updateProbe());
  guard('update:state', () => updateRunner.snapshot());
  guard('update:close', () => {
    if (updateRunner.running()) {
      // The terminal stays until the run finished; only the confirmation window
      // may be dismissed while nothing is running.
      windows.closeUpdateConfirm();
      return;
    }
    windows.closeUpdateWindows();
  });
  guard('update:start', (): UpdateStartResult => {
    if (updateRunner.running()) {
      return { started: false, reason: 'busy', description: 'An update is already running.' };
    }
    const result = resolveUpdatePlan();
    if (!result.ok) {
      return { started: false, reason: result.reason, description: describeUpdateReason(result.reason) };
    }
    const plan: UpdatePlan = result.plan;
    const transaction = createTransactionId(new Date());
    log.info(
      `update requested: ${plan.installedVersion} -> ${plan.version} (tx=${transaction}, root=${plan.canonicalRoot})`,
    );
    // The confirmation has done its job: the terminal window takes over.
    windows.closeUpdateConfirm();
    windows.openUpdateProgress();
    windows.publishUpdate({
      ...updateRunner.snapshot(),
      phase: 'checking',
      message: describeUpdatePhase('checking'),
      targetVersion: plan.version,
      installedVersion: plan.installedVersion,
    });
    void updateRunner
      .run(plan, {
        distro: plan.distro,
        nodePath: supervisor.resolvedRuntime()?.nodePath ?? null,
        transaction,
      })
      .then((outcome) => {
        if (!outcome.ok) {
          log.warn(`update did not complete: ${outcome.state.detail ?? 'unknown'}`);
          return;
        }
        // Let the terminal show the last line, then restart the portable app.
        setTimeout(() => relaunchApp(), 1_200).unref?.();
      })
      .catch((error: unknown) => {
        log.error(`update runner failed: ${error instanceof Error ? error.message : 'unknown'}`);
      });
    return { started: true, reason: null, description: null };
  });

  guard('settings:open-window', () => {
    windows.openSettings();
  });

  guard('shell:retry', async () => {
    await supervisor.retry().catch(() => undefined);
  });

  guard('shell:open-logs', async () => {
    await shell.openPath(join(userData, 'logs'));
  });

  guard('shell:quit', () => {
    quit();
  });

  guard('settings:load', async () => ({
    config,
    distros: await wsl.listDistros().catch((error: unknown) => {
      log.warn(`listing distributions failed: ${error instanceof Error ? error.message : 'unknown'}`);
      return [] as string[];
    }),
    status: supervisor.getStatus(),
    configPath: configStore.path(),
  }));

  guard('settings:distros', async () => wsl.listDistros().catch(() => [] as string[]));

  guard('settings:open-config', async () => {
    await shell.openPath(userData);
  });

  guard('settings:close', () => {
    windows.closeSettingsWindow();
  });

  ipcMain.handle('settings:save', async (event, patch: unknown) => {
    if (!isTrustedSender(event)) throw new Error('untrusted-sender');
    return await saveConfig(patch);
  });

  async function saveConfig(rawPatch: unknown): Promise<{
    ok: boolean;
    errors: string[];
    restartRequired: boolean;
    config: AppConfig;
  }> {
    if (rawPatch === null || typeof rawPatch !== 'object') {
      return { ok: false, errors: ['invalid settings payload'], restartRequired: false, config };
    }
    const patch = rawPatch as ConfigPatch;
    if (typeof patch.port !== 'undefined') {
      const port = Number(patch.port);
      if (Number.isInteger(port) && port > 0) {
        const taken = await probePort(port).catch(() => 'occupied' as const);
        if (taken === 'occupied' && port !== config.port) {
          return {
            ok: false,
            errors: [`port ${port} is already in use; stop the other service or choose a free port`],
            restartRequired: false,
            config,
          };
        }
      }
    }
    const result = applyConfigPatch(config, patch);
    if (result.errors.length > 0) {
      return { ok: false, errors: result.errors, restartRequired: false, config };
    }
    const restartRequired = requiresRestart(config, result.config);
    config = result.config;
    configStore.save(config);
    log.info('settings saved');
    if (restartRequired) log.info('backend restart required to apply new settings');
    return { ok: true, errors: [], restartRequired, config };
  }

  app.on('second-instance', () => {
    windows.showMain();
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quit();
  });

  app.on('window-all-closed', () => {
    // Tray application: closing every window must keep the supervisor alive.
  });

  app.on('activate', () => windows.showMain());

  app.whenReady().then(async () => {
    // Sessions and the tray only become available once Electron is ready.
    windows.configureSession();
    startTray();
    windows.showSplash({ activate: true });
    tray?.update(supervisor.getStatus(), false);
    // Informational only: the footer must never delay or block the backend.
    void versions
      .refreshIfStale()
      .then(() => windows.publishVersions(versionSnapshot()))
      .catch(() => undefined);
    try {
      // An update that was interrupted between the two renames is repaired first:
      // `finalize` keeps the new runtime, `rollback` restores the previous one.
      const recovery = await recoverInterruptedUpdate({
        wsl,
        journal: updateJournal,
        resume: () => supervisor.resumeAfterUpdate(),
        log,
      });
      if (recovery.handled) {
        log.info(`update recovery: ${recovery.action ?? 'none'}${recovery.message === null ? '' : ` — ${recovery.message}`}`);
      }
      if (recovery.action === 'blocked') {
        // Never start a backend on top of a runtime whose state is unknown.
        supervisor.blockForRuntime(
          recovery.message ?? 'The isolated runtime is in an unknown state.',
        );
      } else if (recovery.action === null) {
        await supervisor.start();
      }
    } catch (error) {
      log.error(
        `startup failed: ${error instanceof ShellError ? `${error.code}: ${error.message}` : String(error)}`,
      );
    }
  });
}
