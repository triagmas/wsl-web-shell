import { describe, expect, it } from 'vitest';
import { Supervisor } from '../src/main/core/supervisor.js';
import { createMemoryRegistry } from '../src/main/core/registry.js';
import { backendProbe, createHarness, lastStatus, BACKEND_PID, BACKEND_START_TIME, PORT } from './helpers.js';
import type { OwnedServerRecord } from '../src/main/core/ownership.js';

const record: OwnedServerRecord = {
  presetId: 'deepseek-harness',
  distro: 'Ubuntu',
  port: PORT,
  pid: BACKEND_PID,
  startTime: BACKEND_START_TIME,
  workspace: '~',
  startedAt: '2026-01-01T00:00:00.000Z',
  appVersion: '0.0.0-test',
};

describe('supervisor startup', () => {
  it('starts the owned backend and reaches READY', async () => {
    const harness = createHarness();
    const supervisor = new Supervisor(harness.deps);

    await supervisor.start();

    expect(supervisor.state).toBe('READY');
    expect(harness.wsl.starts).toHaveLength(1);
    expect(harness.wsl.starts[0]).toMatchObject({ distro: 'Ubuntu', port: PORT, host: '127.0.0.1' });
    expect(harness.web.bootstraps).toHaveLength(1);
    // The tokenized URL only ever goes to the session bootstrap call.
    expect(harness.web.bootstraps[0]).toContain('?token=');
    expect(JSON.stringify(harness.statuses)).not.toContain('token=');
    expect(harness.registry.read()).toMatchObject({ pid: BACKEND_PID, startTime: BACKEND_START_TIME, port: PORT });
    expect(lastStatus(harness.statuses).state).toBe('READY');
  });

  it('probes the installed version with the runtime Node.js the backend uses', async () => {
    const harness = createHarness();
    const supervisor = new Supervisor(harness.deps);

    await supervisor.start();

    // `wsl.exe --exec dsh` cannot resolve `#!/usr/bin/env node`, so the probe
    // must carry the same resolved runtime as the launch (issue #11).
    expect(harness.wsl.versionQueries).toHaveLength(1);
    expect(harness.wsl.versionQueries[0]).toEqual({
      distro: 'Ubuntu',
      dshPath: '/usr/local/bin/dsh',
      nodePath: '/usr/bin/node',
    });
    expect(lastStatus(harness.statuses).dshVersion).toBe('0.2.1-rc.5');
  });

  it('fails closed when an unknown listener holds the port', async () => {
    const harness = createHarness({ portState: 'occupied' });
    const supervisor = new Supervisor(harness.deps);

    await expect(supervisor.start()).rejects.toBeTruthy();

    expect(supervisor.state).toBe('ERROR');
    expect(harness.wsl.starts).toHaveLength(0);
    expect(harness.wsl.signals).toHaveLength(0);
    expect(lastStatus(harness.statuses).detail).toContain('does not own');
  });

  it('does not adopt a foreign dsh on the port', async () => {
    const registry = createMemoryRegistry(record);
    const harness = createHarness({
      portState: 'occupied',
      registry,
      wsl: { probe: () => backendProbe({ port: 9999 }) },
    });
    const supervisor = new Supervisor(harness.deps);

    await expect(supervisor.start()).rejects.toBeTruthy();
    expect(supervisor.state).toBe('ERROR');
    expect(registry.read()).toBeNull();
    expect(harness.wsl.starts).toHaveLength(0);
  });

  it('reuses its own live backend without spawning a duplicate', async () => {
    const registry = createMemoryRegistry(record);
    const harness = createHarness({ portState: 'occupied', registry });
    const supervisor = new Supervisor(harness.deps);

    await supervisor.start();

    expect(supervisor.state).toBe('READY');
    expect(harness.wsl.starts).toHaveLength(0);
    expect(lastStatus(harness.statuses).ownedServer).toBe(true);
  });

  it('restarts an owned backend that rejects the stored session cookie', async () => {
    const registry = createMemoryRegistry(record);
    let healthCalls = 0;
    let portBusy = true;
    let alive = true;
    const harness = createHarness({
      portState: () => (portBusy ? 'occupied' : 'free'),
      registry,
      web: { health: () => (healthCalls++ === 0 ? 401 : 200) },
      wsl: {
        probe: (pid) => (alive && pid === BACKEND_PID ? backendProbe() : null),
      },
    });
    harness.wsl.signalHook = (_pid, signal) => {
      if (signal !== 'TERM') return;
      alive = false;
      portBusy = false;
    };
    harness.wsl.startHook = () => {
      alive = true;
    };
    const supervisor = new Supervisor(harness.deps);

    await supervisor.start();

    expect(harness.wsl.signals).toEqual([{ pid: BACKEND_PID, signal: 'TERM' }]);
    expect(harness.wsl.starts).toHaveLength(1);
    expect(supervisor.state).toBe('READY');
  });

  it('reports missing prerequisites without installing anything', async () => {
    const harness = createHarness({ wsl: { distros: ['Debian'] } });
    const supervisor = new Supervisor(harness.deps);

    await expect(supervisor.start()).rejects.toBeTruthy();
    expect(supervisor.state).toBe('ERROR');
    expect(lastStatus(harness.statuses).detail).toContain('not installed');
    expect(harness.wsl.starts).toHaveLength(0);
  });

  it('is serialized: concurrent starts spawn one backend', async () => {
    const harness = createHarness();
    const supervisor = new Supervisor(harness.deps);

    await Promise.all([supervisor.start(), supervisor.start(), supervisor.start()]);

    expect(harness.wsl.starts).toHaveLength(1);
    expect(supervisor.state).toBe('READY');
  });
});

describe('supervisor recovery', () => {
  it('recovers after an unexpected backend exit', async () => {
    const harness = createHarness();
    const supervisor = new Supervisor(harness.deps);
    await supervisor.start();
    expect(supervisor.state).toBe('READY');

    harness.wsl.servers[0]?.exit();

    // The exit handler runs asynchronously; wait for the follow-up start.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(harness.wsl.starts).toHaveLength(2);
    expect(supervisor.state).toBe('READY');
  });

  it('gives up after the bounded retry budget', async () => {
    const harness = createHarness({ config: { maxRestartAttempts: 2 } });
    const supervisor = new Supervisor(harness.deps);
    await supervisor.start();
    expect(supervisor.state).toBe('READY');

    // The next launches never report a PID, so every restart attempt fails.
    harness.wsl.options.pid = null;
    harness.wsl.servers[0]?.exit();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(harness.wsl.starts.length).toBeGreaterThanOrEqual(3);
    expect(supervisor.state).toBe('ERROR');
    expect(harness.statuses.at(-1)?.detail).toContain('could not be restarted');
  });

  it('keeps the backend stopped when auto restart is disabled', async () => {
    const harness = createHarness({ config: { autoRestart: false } });
    const supervisor = new Supervisor(harness.deps);
    await supervisor.start();

    harness.wsl.servers[0]?.exit();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(supervisor.state).toBe('ERROR');
    expect(harness.wsl.starts).toHaveLength(1);
    expect(harness.statuses.at(-1)?.detail).toContain('Automatic restart is disabled');
  });

  it('recovers after two failed health probes', async () => {
    let unhealthyLeft = 0;
    const harness = createHarness({ web: { health: () => (unhealthyLeft-- > 0 ? 0 : 200) } });
    const supervisor = new Supervisor(harness.deps);
    await supervisor.start();

    unhealthyLeft = 2;
    await supervisor.healthTick();
    expect(supervisor.state).toBe('READY');
    await supervisor.healthTick();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(harness.wsl.starts).toHaveLength(2);
    expect(supervisor.state).toBe('READY');
  });
});

describe('supervisor update quiesce (issue #12)', () => {
  it('stops the owned backend and blocks recovery while an update runs', async () => {
    let alive = true;
    const harness = createHarness({ wsl: { probe: (pid) => (alive && pid === BACKEND_PID ? backendProbe() : null) } });
    harness.wsl.signalHook = () => {
      alive = false;
    };
    const supervisor = new Supervisor(harness.deps);
    await supervisor.start();

    const paused = await supervisor.pauseForUpdate();
    expect(paused.ok).toBe(true);
    expect(harness.wsl.signals).toHaveLength(1);
    expect(harness.wsl.signals[0]).toMatchObject({ pid: BACKEND_PID, signal: 'TERM' });
    expect(supervisor.updateInProgress).toBe(true);

    // An exit or a health failure during the swap must not start a new backend.
    harness.wsl.servers[0]?.exit();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await supervisor.healthTick();
    expect(harness.wsl.starts).toHaveLength(1);

    // A manual restart or retry is refused as well.
    await supervisor.restart();
    await supervisor.retry();
    expect(harness.wsl.starts).toHaveLength(1);

    // The update installed a new runtime: the next start uses a new process.
    alive = true;
    const resumed = await supervisor.resumeAfterUpdate();
    expect(resumed.ok).toBe(true);
    expect(supervisor.updateInProgress).toBe(false);
    expect(harness.wsl.starts).toHaveLength(2);
    expect(supervisor.state).toBe('READY');
  });

  it('reports a failed resume instead of claiming success', async () => {
    const harness = createHarness({ web: { bootstrapStatus: 401 } });
    const supervisor = new Supervisor(harness.deps);
    await supervisor.pauseForUpdate();

    // The new runtime cannot serve the WebUI: the resume has to say so.
    const resumed = await supervisor.resumeAfterUpdate();
    expect(resumed.ok).toBe(false);
    expect(resumed.message).toContain('rejected the startup token');
    expect(supervisor.state).toBe('ERROR');
  });

  it('releases the lock and reports an explicit error when the stop fails (P1-C)', async () => {
    const harness = createHarness();
    const supervisor = new Supervisor(harness.deps);
    await supervisor.start();
    expect(supervisor.state).toBe('READY');

    // The ownership probe fails: whether the backend is alive is now unknown.
    const wsl = harness.deps.wsl as unknown as { probeProcess: () => Promise<unknown> };
    const original = wsl.probeProcess;
    wsl.probeProcess = async () => {
      throw new Error('wsl.exe is not responding');
    };
    const paused = await supervisor.pauseForUpdate();
    wsl.probeProcess = original;

    expect(paused.ok).toBe(false);
    // No silent soft-lock: the flag is cleared and the state is explicit.
    expect(supervisor.updateInProgress).toBe(false);
    expect(supervisor.state).toBe('ERROR');
    expect(lastStatus(harness.statuses).detail).toContain('could not be stopped');

    // The app is not stuck: a retry starts the backend again.
    harness.wsl.servers.length = 0;
    await supervisor.retry();
    expect(supervisor.state).toBe('READY');
    expect(harness.wsl.starts).toHaveLength(2);
  });

  it('exposes a terminal state for a runtime that cannot be recovered', () => {
    const harness = createHarness();
    const supervisor = new Supervisor(harness.deps);
    supervisor.blockForRuntime('nothing to restore');
    expect(supervisor.state).toBe('ERROR');
    expect(lastStatus(harness.statuses).detail).toContain('nothing to restore');
  });
});

describe('supervisor shutdown', () => {
  it('stops only the owned process and clears its record', async () => {
    let alive = true;
    const registry = createMemoryRegistry();
    const harness = createHarness({
      registry,
      wsl: { probe: (pid) => (alive && pid === BACKEND_PID ? backendProbe() : null) },
    });
    harness.wsl.signalHook = () => {
      alive = false;
    };
    const supervisor = new Supervisor(harness.deps);
    await supervisor.start();
    expect(registry.read()).not.toBeNull();

    await supervisor.shutdown();

    expect(supervisor.state).toBe('QUITTING');
    expect(harness.wsl.signals[0]).toEqual({ pid: BACKEND_PID, signal: 'TERM' });
    expect(harness.wsl.signals.filter((entry) => entry.signal === 'KILL')).toHaveLength(0);
    expect(registry.read()).toBeNull();
  });

  it('never kills a process that stopped matching the recorded backend', async () => {
    const registry = createMemoryRegistry();
    const harness = createHarness({
      registry,
      wsl: {
        probe: () => ({
          startTime: BACKEND_START_TIME,
          cmdline: '/usr/bin/some-other-service --port 3080',
          argv: ['/usr/bin/some-other-service', '--port', '3080'],
        }),
      },
    });
    const supervisor = new Supervisor(harness.deps);
    await expect(supervisor.start()).rejects.toBeTruthy();

    await supervisor.shutdown();
    expect(harness.wsl.signals).toHaveLength(0);
  });

  it('refuses to restart a backend it does not own', async () => {
    const harness = createHarness({ wsl: { distros: ['Debian'] } });
    const supervisor = new Supervisor(harness.deps);
    await expect(supervisor.start()).rejects.toBeTruthy();
    harness.wsl.starts.length = 0;

    await supervisor.restart();

    expect(harness.wsl.starts).toHaveLength(0);
    expect(harness.wsl.signals).toHaveLength(0);
    expect(harness.statuses.at(-1)?.detail).toContain('started by this app');
  });
});
