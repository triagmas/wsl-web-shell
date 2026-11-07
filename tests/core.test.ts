import { describe, expect, it } from 'vitest';
import { Lifecycle, InvalidTransitionError, backoffDelay, canTransition } from '../src/main/core/lifecycle.js';
import { decideNavigation, decidePermission, decideWindowOpen } from '../src/main/core/navigation.js';
import { classifyPortSituation } from '../src/main/core/port.js';
import { applyConfigPatch, normalizeConfig, requiresRestart, isValidPort } from '../src/main/core/config.js';
import { buildTrayMenu, trayTooltip } from '../src/main/core/tray-model.js';
import { DEFAULT_CONFIG, type ShellStatus } from '../src/shared/types.js';

function status(patch: Partial<ShellStatus> = {}): ShellStatus {
  return {
    state: 'READY',
    message: 'Ready',
    detail: null,
    ownedServer: true,
    canRetry: false,
    port: 3080,
    distro: 'Ubuntu',
    attempt: 0,
    maxAttempts: 4,
    logPath: '/tmp/app.log',
    dshVersion: null,
    dshPath: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

describe('lifecycle state machine', () => {
  it('follows the documented happy path', () => {
    const lifecycle = new Lifecycle();
    for (const state of ['STARTING_WSL', 'STARTING_WEB', 'CONNECTING', 'READY'] as const) {
      lifecycle.transition(state);
    }
    expect(lifecycle.state).toBe('READY');
    lifecycle.transition('HIDDEN_IN_TRAY');
    expect(lifecycle.state).toBe('HIDDEN_IN_TRAY');
    lifecycle.transition('READY');
    expect(lifecycle.state).toBe('READY');
  });

  it('rejects undocumented jumps', () => {
    const lifecycle = new Lifecycle();
    expect(() => lifecycle.transition('READY')).toThrow(InvalidTransitionError);
    expect(canTransition('ERROR', 'READY')).toBe(false);
    expect(canTransition('ERROR', 'CHECKING')).toBe(true);
  });

  it('is idempotent and observable', () => {
    const lifecycle = new Lifecycle();
    const seen: string[] = [];
    lifecycle.onChange((state) => seen.push(state));
    lifecycle.transition('STARTING_WSL');
    expect(lifecycle.transition('STARTING_WSL')).toBe(false);
    expect(seen).toEqual(['STARTING_WSL']);
  });

  it('can force quit from any state', () => {
    const lifecycle = new Lifecycle();
    lifecycle.transition('ERROR');
    lifecycle.forceQuit();
    expect(lifecycle.state).toBe('QUITTING');
    expect(() => lifecycle.transition('READY')).toThrow(InvalidTransitionError);
  });

  it('caps the backoff delay', () => {
    expect(backoffDelay(0)).toBe(1_000);
    expect(backoffDelay(1)).toBe(2_000);
    expect(backoffDelay(3)).toBe(8_000);
    expect(backoffDelay(20)).toBe(8_000);
  });
});

describe('navigation policy', () => {
  const origin = 'http://127.0.0.1:3080';

  it('allows same-origin document navigation', () => {
    expect(decideNavigation({ url: `${origin}/chat`, origin, isMainFrame: true, isUserInitiated: true })).toEqual({
      action: 'allow',
    });
  });

  it('blocks in-window navigation to other origins', () => {
    expect(
      decideNavigation({ url: 'https://example.com/', origin, isMainFrame: true, isUserInitiated: false }),
    ).toEqual({ action: 'external-blocked', reason: 'not-user-initiated' });
    expect(decideNavigation({ url: 'http://127.0.0.1:9090/', origin, isMainFrame: true, isUserInitiated: true })).toEqual({
      action: 'block',
      reason: 'unsupported-scheme:http',
    });
    expect(decideNavigation({ url: 'javascript:alert(1)', origin, isMainFrame: true, isUserInitiated: true })).toEqual({
      action: 'block',
      reason: 'unsupported-scheme:javascript',
    });
  });

  it('hands user-initiated HTTPS links to the system browser', () => {
    expect(
      decideNavigation({ url: 'https://deepseek.com/', origin, isMainFrame: true, isUserInitiated: true }),
    ).toEqual({ action: 'external', url: 'https://deepseek.com/' });
  });

  it('always denies popups, including same-origin ones', () => {
    expect(decideWindowOpen(`${origin}/x`, origin)).toEqual({ action: 'block', reason: 'popup-not-allowed' });
    expect(decideWindowOpen('https://deepseek.com/', origin)).toEqual({
      action: 'external',
      url: 'https://deepseek.com/',
    });
  });

  it('grants only the tiny permission allowlist', () => {
    expect(decidePermission('fullscreen')).toBe(true);
    expect(decidePermission('clipboard-sanitized-write')).toBe(true);
    for (const denied of ['media', 'geolocation', 'notifications', 'midi', 'openExternal']) {
      expect(decidePermission(denied)).toBe(false);
    }
  });
});

describe('port ownership decisions', () => {
  it('starts a new backend on a free port', () => {
    expect(classifyPortSituation('free', 'gone')).toBe('free');
  });

  it('reuses only a verified app-owned backend', () => {
    expect(classifyPortSituation('occupied', 'owned')).toBe('reuse-owned');
  });

  it('fails closed for unknown listeners', () => {
    expect(classifyPortSituation('occupied', 'foreign')).toBe('collision');
    expect(classifyPortSituation('occupied', 'gone')).toBe('collision');
    expect(classifyPortSituation('occupied', 'unknown')).toBe('collision');
  });
});

describe('configuration', () => {
  it('normalizes hostile persisted input', () => {
    expect(normalizeConfig(null)).toEqual(DEFAULT_CONFIG);
    const config = normalizeConfig({ distro: 'Ubuntu; rm -rf /', port: 80, workspace: 'C:\\x', maxRestartAttempts: 99 });
    expect(config.distro).toBe('Ubuntu');
    expect(config.port).toBe(3080);
    expect(config.workspace).toBe('~');
    expect(config.maxRestartAttempts).toBe(DEFAULT_CONFIG.maxRestartAttempts);
  });

  it('applies valid patches and reports field errors', () => {
    const ok = applyConfigPatch(DEFAULT_CONFIG, { port: 8080, workspace: '/home/me/work' });
    expect(ok.errors).toEqual([]);
    expect(ok.config.port).toBe(8080);
    expect(ok.changed).toBe(true);

    const bad = applyConfigPatch(DEFAULT_CONFIG, { port: 22, distro: 'a b' });
    expect(bad.errors).toHaveLength(2);
    expect(bad.config).toEqual(DEFAULT_CONFIG);
  });

  it('flags backend-restarting changes only', () => {
    const next = applyConfigPatch(DEFAULT_CONFIG, { port: 8080 }).config;
    expect(requiresRestart(DEFAULT_CONFIG, next)).toBe(true);
    const cosmetic = applyConfigPatch(DEFAULT_CONFIG, { openOnLaunch: false }).config;
    expect(requiresRestart(DEFAULT_CONFIG, cosmetic)).toBe(false);
    expect(isValidPort(65535)).toBe(true);
  });
});

describe('tray menu model', () => {
  it('exposes the documented actions', () => {
    const labels = buildTrayMenu(status(), { windowVisible: true }).map((item) =>
      item.type === 'separator' ? '—' : item.label,
    );
    expect(labels[0]).toBe('Focus window');
    expect(labels.join('|')).toContain('Status: Connected');
    expect(labels).toContain('Restart WebUI');
    expect(labels).toContain('Settings…');
    expect(labels).toContain('Quit');
  });

  it('enables Restart only for an owned backend', () => {
    const item = (s: ShellStatus) =>
      buildTrayMenu(s, { windowVisible: false }).find(
        (entry): entry is Extract<ReturnType<typeof buildTrayMenu>[number], { type: 'normal' }> =>
          entry.type === 'normal' && entry.id === 'restart',
      );
    expect(item(status())?.enabled).toBe(true);
    expect(item(status({ ownedServer: false }))?.enabled).toBe(false);
    expect(item(status({ state: 'RECOVERING' }))?.enabled).toBe(false);
    expect(item(status({ state: 'ERROR' }))?.label).toBe('Retry');
  });

  it('marks an unmanaged backend in the tooltip and status line', () => {
    expect(trayTooltip(status({ ownedServer: false }))).toContain('not managed');
  });
});

describe('loopback port probe', () => {
  it('distinguishes a free port from an occupied one', async () => {
    const { createServer } = await import('node:net');
    const { probePort } = await import('../src/main/core/port.js');

    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    expect(await probePort(address.port)).toBe('occupied');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await probePort(address.port)).toBe('free');
  });
});
