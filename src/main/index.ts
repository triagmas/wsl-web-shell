/**
 * Electron main entry point.
 *
 * Owns the single-instance lock, the supervisor lifetime, the tray, the
 * sandboxed backend window and the local splash/settings surfaces.
 */
import { app, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { applyConfigPatch, requiresRestart } from './core/config.js';
import {
  CLEAN_SHUTDOWN_MARKER,
  describeChildProcessGone,
  describeError,
  describeWindowEvent,
  summarizePreviousSession,
} from './core/diagnostics.js';
import { createLatestVersionService } from './backend/github-versions.js';
import { describeInstallScope, type DshInstallation, type SharedDshReport } from './core/dsh-locate.js';
import { buildManualUpdatePlan, type ManualUpdatePlan } from './core/manual-update.js';
import { buildUpdateLogPath, buildUpdateResult, buildUpdateScript, planRunsInConsole } from './core/update-console.js';
import { runInConsole } from './wsl/console.js';
import { APP_DISPLAY_NAME, APP_ID, PROFILE_DIRECTORY } from './core/branding.js';
import { createLogger } from './core/logger.js';
import { isNewer } from './core/versions.js';
import { parsePopoverAnchor } from './core/footer.js';
import { probePort } from './core/port.js';
import { createFileExternalStore } from './core/external.js';
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
  UpdateRunResult,
  VersionSnapshot,
} from '../shared/types.js';

/**
 * Identity and profile (issue #14).
 *
 * The product is now called "DSH WSL", but the profile directory keeps its
 * established name: it holds `config.json`, logs, the owned-server registry and
 * the versions cache. Changing it would silently orphan the user's settings and
 * port choice, so the path is pinned here, before anything reads `userData`.
 */
app.setName(APP_DISPLAY_NAME);
app.setPath('userData', join(app.getPath('appData'), PROFILE_DIRECTORY));

/**
 * Profile self-test (issue #14).
 *
 * Proves on a packaged build — portable and installed — that the rename did not
 * move the profile: the recorded `userData` must still point at
 * `%APPDATA%\wsl-web-shell`, where the user's config and logs live.
 *
 *   DSH WSL.exe --profile-probe=<file.json>
 */
const PROFILE_PROBE_PREFIX = '--profile-probe=';
const profileProbeArg = process.argv.find((argument) => argument.startsWith(PROFILE_PROBE_PREFIX));

if (profileProbeArg !== undefined) {
  const target = profileProbeArg.slice(PROFILE_PROBE_PREFIX.length);
  try {
    writeFileSync(
      target,
      `${JSON.stringify(
        {
          name: app.getName(),
          version: app.getVersion(),
          packaged: app.isPackaged,
          execPath: process.execPath,
          appData: app.getPath('appData'),
          userData: app.getPath('userData'),
          configPath: join(app.getPath('userData'), 'config.json'),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    app.exit(0);
  } catch {
    app.exit(1);
  }
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
  const external = createFileExternalStore(join(userData, 'external-backend.json'));
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
    onSessionEnd: () => {
      log.info('system session end: quitting gracefully');
      quit();
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

  /**
   * Read-only inspection of the installation the launcher uses.
   *
   * Runs only when the update window opens or asks to check again, never on the
   * launch path. It is deliberately not cached: after the owner runs the manual
   * command, a cached report would keep claiming the old version until the app
   * restarts.
   */
  async function inspectInstallation(): Promise<SharedDshReport | null> {
    const runtime = supervisor.resolvedRuntime();
    const status = supervisor.getStatus();
    const dshPath = runtime?.dshPath ?? status.dshPath;
    if (dshPath === null) return null;
    try {
      return await wsl.inspectSharedDsh({
        distro: config.distro,
        appRoot: config.runtimeRoot,
        dshPath,
        nodePath: runtime?.nodePath ?? null,
        ownPid: supervisor.ownedPid(),
      });
    } catch (error) {
      log.warn(`update: inspecting the installation failed: ${error instanceof Error ? error.message : 'unknown'}`);
      return null;
    }
  }

  /**
   * What the update window shows.
   *
   * DSH WSL does not update anything: it reports the installed and the published
   * version and the exact commands the owner runs. The backend kind decides
   * whether those commands include stopping and starting a unit, and only a
   * read-only probe supplies the unit name.
   */
  async function updatePlan(force = false): Promise<{ probe: UpdateProbe; plan: ManualUpdatePlan; installation: DshInstallation | null }> {
    // "Check again" is an explicit request, so it must not wait out the 18-hour
    // cache: the owner pressed it because they expect a version published since
    // the last lookup to appear.
    await (force ? versions.refresh() : versions.refreshIfStale()).catch(() => undefined);
    const status = supervisor.getStatus();
    const runtime = supervisor.resolvedRuntime();
    const report = await inspectInstallation();
    const installation = report?.installation ?? null;
    const target = versions.snapshot().latest?.version ?? null;

    let backend: 'owned' | 'attached' | 'none' = 'none';
    let unit: { scope: 'system' | 'user'; name: string } | null = null;
    if (status.ownedServer) {
      backend = 'owned';
    } else if (status.externalBackend) {
      backend = 'attached';
      const managed = await supervisor.discoverAttachedUnit();
      if (managed !== null && managed.scope !== 'none' && managed.unit !== null) {
        unit = { scope: managed.scope, name: managed.unit };
      }
    }

    const plan = buildManualUpdatePlan({
      installation,
      target,
      targetError: versions.snapshot().error,
      backend,
      unit,
    });
    return {
      plan,
      installation,
      probe: {
        installed: plan.installed,
        target,
        distro: config.distro,
        dshPath: installation?.path ?? runtime?.dshPath ?? status.dshPath,
        installManager: installation?.manager ?? 'unknown',
        installScope: installation === null ? 'unknown' : describeInstallScope(installation.prefix),
        commands: plan.commands,
        description: plan.description,
        state: plan.state,
        runAvailable: planRunsInConsole(plan),
      },
    };
  }

  async function updateProbe(force = false): Promise<UpdateProbe> {
    return (await updatePlan(force)).probe;
  }

  let consoleUpdateRunning = false;

  /**
   * Run the plan's commands in one visible WSL console and report what changed.
   *
   * The supervisor is paused for the duration: left running, it would see the
   * unit stop as a lost backend and start its own from the files npm is
   * replacing (the beta.6 EADDRINUSE bug). It resumes on every outcome, so a
   * failed install still ends with the service running on the old version.
   */
  async function runConsoleUpdate(): Promise<UpdateRunResult> {
    if (consoleUpdateRunning) throw new Error('A console update is already running.');
    consoleUpdateRunning = true;
    try {
      const before = await updatePlan(false);
      if (!planRunsInConsole(before.plan)) throw new Error('these commands cannot run in one console');
      const logPath = buildUpdateLogPath(new Date().toISOString().replace(/[:.]/g, '-'));
      const script = logPath === null ? null : buildUpdateScript(before.plan.commands, logPath);
      if (logPath === null || script === null) throw new Error('the update script could not be built');
      log.info(`console update: ${before.plan.commands.length} command(s), log ${logPath}`);
      await supervisor.suspendForUpdate();
      let code: number | null = null;
      try {
        ({ code } = await runInConsole({ distro: config.distro, script }));
      } finally {
        await supervisor.resumeAfterUpdate();
      }
      const after = await updatePlan(true);
      const result = buildUpdateResult({
        code,
        logPath,
        before: before.probe.installed,
        after: after.probe.installed,
        target: after.probe.target,
        installation: after.installation ?? before.installation,
      });
      log.info(
        `console update finished: code=${code ?? 'null'} success=${result.success} installed=${result.installed ?? 'unknown'}`,
      );
      return result;
    } finally {
      consoleUpdateRunning = false;
    }
  }

  const supervisor: Supervisor = new Supervisor({
    config: () => config,
    wsl,
    web,
    registry,
    external,
    // A cold start gives a backend the owner runs outside this app a short head
    // start before the app takes the port for its own backend.
    discoveryGraceMs: 5_000,
    discoveryPollMs: 500,
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
    quitting = true;
    log.info('quit requested');
    if (healthTimer !== null) clearTimeout(healthTimer);
    healthTimer = null;
    windows.setQuitting();
    tray?.destroy();
    tray = null;
    const detached = supervisor.detach().catch((error: unknown) => {
      log.error(`detaching the backend failed: ${error instanceof Error ? error.message : 'unknown'}`);
    });
    void detached.finally(() => {
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
            title: 'DSH WSL — Connection status',
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

  // --- manual update window (issue #12 follow-up) -----------------------
  guard('footer:open-update', () => {
    windows.closeSettingsPopover();
    windows.openUpdateConfirm();
  });
  // Both channels inspect again: the window must never show a stale verdict
  // after the owner ran a command in a WSL terminal.
  guard('update:probe', async () => await updateProbe());
  guard('update:recheck', async () => await updateProbe(true));
  // The one channel that runs anything: the same commands the window shows, in
  // a visible console, and nothing else.
  guard('update:run', async () => await runConsoleUpdate());
  guard('update:close', () => {
    windows.closeUpdateConfirm();
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
      await supervisor.start();
    } catch (error) {
      log.error(
        `startup failed: ${error instanceof ShellError ? `${error.code}: ${error.message}` : String(error)}`,
      );
    }
  });
}
