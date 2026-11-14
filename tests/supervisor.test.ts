import { describe, expect, it } from 'vitest';
import { Supervisor } from '../src/main/core/supervisor.js';
import { createMemoryExternalStore } from '../src/main/core/external.js';
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

  it('keeps the ownership record when the port is busy and the probe fails', async () => {
    const registry = createMemoryRegistry(record);
    const harness = createHarness({
      portState: 'occupied',
      registry,
      wsl: { probe: () => null },
    });
    const supervisor = new Supervisor(harness.deps);

    await expect(supervisor.start()).rejects.toBeTruthy();

    expect(supervisor.state).toBe('ERROR');
    // The record is the only proof the next start can use; an inconclusive
    // probe must not delete it (regression: an orphaned live backend).
    expect(registry.read()).toEqual(record);
    expect(harness.wsl.starts).toHaveLength(0);
    expect(harness.wsl.signals).toHaveLength(0);
  });

  it('adopts the backend once the ownership probe works again', async () => {
    const registry = createMemoryRegistry(record);
    let probeWorks = false;
    const harness = createHarness({
      portState: 'occupied',
      registry,
      wsl: { probe: (pid) => (probeWorks && pid === BACKEND_PID ? backendProbe() : null) },
    });
    const supervisor = new Supervisor(harness.deps);

    await expect(supervisor.start()).rejects.toBeTruthy();
    expect(registry.read()).toEqual(record);

    probeWorks = true;
    await supervisor.retry();

    expect(supervisor.state).toBe('READY');
    expect(harness.wsl.starts).toHaveLength(0);
    expect(harness.wsl.signals).toHaveLength(0);
    expect(lastStatus(harness.statuses).ownedServer).toBe(true);
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

describe('supervisor detach (backend outlives the app)', () => {
  it('leaves the owned backend running and keeps its record', async () => {
    const registry = createMemoryRegistry();
    const harness = createHarness({ registry });
    const supervisor = new Supervisor(harness.deps);
    await supervisor.start();
    const recorded = registry.read();
    expect(recorded).not.toBeNull();

    await supervisor.detach();

    expect(supervisor.state).toBe('QUITTING');
    // No signal, no launcher stop: only the app exits.
    expect(harness.wsl.signals).toHaveLength(0);
    expect(harness.wsl.servers[0]?.stopCalls).toBe(0);
    expect(registry.read()).toEqual(recorded);
  });

  it('lets the next start adopt the backend that outlived the app', async () => {
    const registry = createMemoryRegistry();
    const first = createHarness({ registry });
    const app = new Supervisor(first.deps);
    await app.start();
    const spawned = first.wsl.servers[0];
    await app.detach();

    const second = createHarness({ portState: 'occupied', registry });
    const relaunched = new Supervisor(second.deps);
    await relaunched.start();

    expect(relaunched.state).toBe('READY');
    expect(second.wsl.starts).toHaveLength(0);
    expect(second.wsl.signals).toHaveLength(0);
    expect(spawned?.stopCalls).toBe(0);
    expect(lastStatus(second.statuses).ownedServer).toBe(true);
  });
});

describe('external backend attach', () => {
  const EXTERNAL_PID = 4711;
  const externalWsl = {
    portOwner: EXTERNAL_PID,
    probe: (pid: number) => (pid === EXTERNAL_PID ? backendProbe() : null),
  };

  it('attaches to a verified backend it does not own and never signals it', async () => {
    const harness = createHarness({ portState: 'occupied', wsl: externalWsl });
    const supervisor = new Supervisor(harness.deps);

    await supervisor.start();

    expect(supervisor.state).toBe('READY');
    const ready = lastStatus(harness.statuses);
    expect(ready.externalBackend).toBe(true);
    expect(ready.ownedServer).toBe(false);
    expect(harness.wsl.starts).toHaveLength(0);
    expect(harness.wsl.signals).toHaveLength(0);
    // No record is written: the app does not claim a process it does not own.
    expect(harness.registry.read()).toBeNull();

    // Restart refuses instead of signalling a process outside the app.
    await supervisor.restart();
    expect(harness.wsl.signals).toHaveLength(0);
    expect(lastStatus(harness.statuses).detail).toContain('runs outside this app');
  });

  it('falls back to the collision error when the stored session is rejected', async () => {
    const harness = createHarness({
      portState: 'occupied',
      web: { health: () => 401 },
      wsl: externalWsl,
    });
    const supervisor = new Supervisor(harness.deps);

    await expect(supervisor.start()).rejects.toThrow(/already in use/);
    expect(supervisor.state).toBe('ERROR');
    expect(lastStatus(harness.statuses).externalBackend).toBe(false);
    // The hint names the real situation: a verified DSH this profile has no
    // session for, not an arbitrary unknown service.
    expect(lastStatus(harness.statuses).detail).toContain('has never authenticated');
    expect(harness.wsl.starts).toHaveLength(0);
    expect(harness.wsl.signals).toHaveLength(0);
  });

  it('refuses a listener whose command line is not an app-compatible dsh launch', async () => {
    const harness = createHarness({
      portState: 'occupied',
      wsl: { portOwner: EXTERNAL_PID, probe: (pid: number) => (pid === EXTERNAL_PID ? backendProbe({ port: 9999 }) : null) },
    });
    const supervisor = new Supervisor(harness.deps);

    await expect(supervisor.start()).rejects.toThrow(/already in use/);
    expect(supervisor.state).toBe('ERROR');
    expect(harness.wsl.starts).toHaveLength(0);
    expect(harness.wsl.signals).toHaveLength(0);
  });

  it('reports a lost attached backend without spawning a competitor', async () => {
    let healthy = true;
    const harness = createHarness({
      portState: 'occupied',
      web: { health: () => (healthy ? 200 : 401) },
      wsl: externalWsl,
    });
    const supervisor = new Supervisor(harness.deps);
    await supervisor.start();
    expect(supervisor.state).toBe('READY');

    healthy = false;
    await supervisor.healthTick();
    await supervisor.healthTick();

    expect(supervisor.state).toBe('ERROR');
    expect(lastStatus(harness.statuses).detail).toContain('outside this app');
    expect(harness.wsl.starts).toHaveLength(0);
    expect(harness.wsl.signals).toHaveLength(0);
  });
});

describe('external backend expectation (boot race)', () => {
  const EXTERNAL_PID = 4711;
  const externalWsl = {
    portOwner: EXTERNAL_PID,
    probe: (pid: number) => (pid === EXTERNAL_PID ? backendProbe() : null),
  };
  const expectation = (port = PORT) => ({
    distro: 'Ubuntu',
    port,
    recordedAt: '2026-01-01T00:00:00.000Z',
  });

  it('waits for the expected backend instead of spawning a competitor', async () => {
    // The port is still free while the owner's unit boots, then the unit binds.
    let probes = 0;
    const harness = createHarness({
      portState: () => (probes++ < 3 ? 'free' : 'occupied'),
      wsl: externalWsl,
      external: createMemoryExternalStore(expectation()),
      attachWaitMs: 100,
      attachPollMs: 5,
    });
    const supervisor = new Supervisor(harness.deps);

    await supervisor.start();

    expect(supervisor.state).toBe('READY');
    expect(lastStatus(harness.statuses).externalBackend).toBe(true);
    expect(harness.wsl.starts).toHaveLength(0);
    expect(harness.wsl.signals).toHaveLength(0);
    expect(harness.registry.read()).toBeNull();
  });

  it('serves beside the reserved port when the expected backend does not appear, and counts the miss', async () => {
    const external = createMemoryExternalStore(expectation());
    const harness = createHarness({ portState: 'free', external, attachWaitMs: 30, attachPollMs: 5 });
    const supervisor = new Supervisor(harness.deps);

    await supervisor.start();

    // The WebUI has to be served even when the owner's launcher is down, but the
    // launcher's port stays free for it: a competitor there would put its unit
    // into a permanent EADDRINUSE restart loop.
    expect(supervisor.state).toBe('READY');
    expect(harness.wsl.starts).toHaveLength(1);
    expect(harness.wsl.starts[0]?.port).toBe(PORT + 1);
    expect(lastStatus(harness.statuses).port).toBe(PORT + 1);
    expect(lastStatus(harness.statuses).externalBackend).toBe(false);
    expect(external.read()?.misses).toBe(1);
    expect(external.read()?.port).toBe(PORT);
  });

  it('keeps the port reserved after three misses and skips the wait', async () => {
    const external = createMemoryExternalStore({ ...expectation(), misses: 2 });
    const harness = createHarness({ portState: 'free', external, attachWaitMs: 30, attachPollMs: 5 });
    const supervisor = new Supervisor(harness.deps);

    await supervisor.start();

    expect(supervisor.state).toBe('READY');
    expect(harness.wsl.starts).toHaveLength(1);
    // The expectation survives: only an explicit "take the port" action gives it
    // up, and the port stays reserved for the launcher on every later start.
    expect(external.read()?.misses).toBe(3);
    expect(external.read()?.port).toBe(PORT);
    expect(harness.wsl.starts[0]?.port).toBe(PORT + 1);
  });

  it('hands the reserved port back once the launcher answers, and keeps WSL open after', async () => {
    const EXTERNAL_PID = 4711;
    let launcherUp = false;
    const external = createMemoryExternalStore(expectation());
    const harness = createHarness({
      portState: (port: number) => (port === PORT && launcherUp ? 'occupied' : 'free'),
      wsl: {
        portOwner: (port: number) => (port === PORT && launcherUp ? EXTERNAL_PID : null),
        probe: (pid: number) => {
          if (pid === EXTERNAL_PID) return backendProbe({ port: PORT });
          if (pid === BACKEND_PID) return backendProbe({ port: PORT + 1 });
          return null;
        },
      },
      external,
      attachWaitMs: 30,
      attachPollMs: 5,
    });
    const supervisor = new Supervisor(harness.deps);
    await supervisor.start();
    expect(harness.wsl.starts[0]?.port).toBe(PORT + 1);

    // The owner's launcher binds its own port again.
    launcherUp = true;
    await supervisor.healthTick();

    expect(supervisor.state).toBe('READY');
    expect(lastStatus(harness.statuses).externalBackend).toBe(true);
    expect(lastStatus(harness.statuses).port).toBe(PORT);
    // The fallback backend is stopped, never the launcher's process.
    expect(harness.wsl.signals.length).toBeGreaterThan(0);
    expect(harness.wsl.signals.every((sent) => sent.pid === BACKEND_PID)).toBe(true);
    // WSL2 powers a distribution off without a client; the attached mode has to
    // keep one, or the owner's backend dies about ten seconds later.
    expect(harness.wsl.keepalives).toEqual(['Ubuntu']);
  });

  it('pauses for a console update and does not resurrect the stopped backend', async () => {
    let alive = true;
    const harness = createHarness({
      wsl: { probe: (pid) => (alive && pid === BACKEND_PID ? backendProbe() : null) },
    });
    harness.wsl.signalHook = (_pid, signal) => {
      if (signal === 'TERM') alive = false;
    };
    harness.wsl.startHook = () => {
      alive = true;
    };
    const supervisor = new Supervisor(harness.deps);
    await supervisor.start();
    const startsBefore = harness.wsl.starts.length;

    // The app stops its own backend through the ownership-proven path, so the
    // console never needs a `kill` line for a process it did not start.
    await supervisor.suspendForUpdate();
    expect(harness.wsl.signals).toEqual([{ pid: BACKEND_PID, signal: 'TERM' }]);

    // The exit that follows is part of the update, not an accident: recovery,
    // health checks and the hand-back decision must all stay quiet while the
    // console owns the backend (beta.6 EADDRINUSE).
    await supervisor.handleServerExit({ code: 0, signal: null }, 1);
    await supervisor.healthTick();
    expect(harness.wsl.starts).toHaveLength(startsBefore);
    expect(harness.wsl.keepalives).toEqual([]);
  });

  it('resumes after the console update and brings the backend back', async () => {
    let alive = true;
    const harness = createHarness({
      wsl: { probe: (pid) => (alive && pid === BACKEND_PID ? backendProbe() : null) },
    });
    harness.wsl.signalHook = (_pid, signal) => {
      if (signal === 'TERM') alive = false;
    };
    harness.wsl.startHook = () => {
      alive = true;
    };
    const supervisor = new Supervisor(harness.deps);
    await supervisor.start();
    const startsBefore = harness.wsl.starts.length;

    await supervisor.suspendForUpdate();
    await supervisor.resumeAfterUpdate();

    expect(harness.wsl.starts.length).toBe(startsBefore + 1);
    expect(supervisor.state).toBe('READY');
  });

  it('re-arms the distribution keepalive when whatever held WSL open is gone', async () => {
    const EXTERNAL_PID = 4711;
    let keeperAlive = true;
    const harness = createHarness({
      portState: (port: number) => (port === PORT ? 'occupied' : 'free'),
      wsl: {
        portOwner: (port: number) => (port === PORT ? EXTERNAL_PID : null),
        probe: (pid: number) => (pid === EXTERNAL_PID ? backendProbe({ port: PORT }) : null),
      },
      external: createMemoryExternalStore(expectation()),
      attachWaitMs: 30,
      attachPollMs: 5,
      keepaliveAlive: () => keeperAlive,
    });
    const supervisor = new Supervisor(harness.deps);
    await supervisor.start();
    expect(harness.wsl.keepalives).toEqual(['Ubuntu']);

    // A healthy tick with a live session must not spawn a second one.
    await supervisor.healthTick();
    expect(harness.wsl.keepalives).toEqual(['Ubuntu']);

    // The session died: the distribution now has about ten seconds before WSL2
    // powers it off and takes the owner's backend with it.
    keeperAlive = false;
    await supervisor.healthTick();
    expect(harness.wsl.keepalives).toEqual(['Ubuntu', 'Ubuntu']);

    // The new session holds, so the next tick is quiet again.
    keeperAlive = true;
    await supervisor.healthTick();
    expect(harness.wsl.keepalives).toEqual(['Ubuntu', 'Ubuntu']);
  });

  it('keeps serving beside the reserved port when the launcher rejects this profile', async () => {
    const EXTERNAL_PID = 4711;
    let launcherUp = false;
    const harness = createHarness({
      portState: (port: number) => (port === PORT && launcherUp ? 'occupied' : 'free'),
      wsl: {
        portOwner: (port: number) => (port === PORT && launcherUp ? EXTERNAL_PID : null),
        probe: (pid: number) => {
          if (pid === EXTERNAL_PID) return backendProbe({ port: PORT });
          if (pid === BACKEND_PID) return backendProbe({ port: PORT + 1 });
          return null;
        },
      },
      // The launcher answers the port but not this profile's session.
      web: { health: (origin: string) => (origin.endsWith(`:${PORT}`) ? 401 : 200) },
      external: createMemoryExternalStore(expectation()),
      attachWaitMs: 30,
      attachPollMs: 5,
    });
    const supervisor = new Supervisor(harness.deps);
    await supervisor.start();

    launcherUp = true;
    await supervisor.healthTick();

    // Handing the port to a backend that would not serve this profile would
    // leave the owner with nothing, so the app keeps its own backend.
    expect(supervisor.state).toBe('READY');
    expect(lastStatus(harness.statuses).externalBackend).toBe(false);
    expect(lastStatus(harness.statuses).port).toBe(PORT + 1);
    expect(harness.wsl.signals).toHaveLength(0);
    expect(harness.wsl.keepalives).toEqual([]);
  });

  it('looks for the launcher on its own port when the recorded fallback died', async () => {
    const EXTERNAL_PID = 4711;
    const fallback: OwnedServerRecord = { ...record, port: PORT + 1, pid: 9001, startTime: '777' };
    const registry = createMemoryRegistry(fallback);
    const harness = createHarness({
      portState: (port: number) => (port === PORT ? 'occupied' : 'free'),
      wsl: {
        portOwner: (port: number) => (port === PORT ? EXTERNAL_PID : null),
        // The recorded fallback process is gone; the launcher is on its own port.
        probe: (pid: number) => (pid === EXTERNAL_PID ? backendProbe({ port: PORT }) : null),
      },
      registry,
      external: createMemoryExternalStore(expectation()),
      attachWaitMs: 30,
      attachPollMs: 5,
    });
    const supervisor = new Supervisor(harness.deps);

    await supervisor.start();

    // Discovery belongs on the launcher's port, not on a dead fallback port.
    expect(supervisor.state).toBe('READY');
    expect(lastStatus(harness.statuses).externalBackend).toBe(true);
    expect(lastStatus(harness.statuses).port).toBe(PORT);
    expect(harness.wsl.starts).toHaveLength(0);
    expect(registry.read()).toBeNull();
  });

  it('keeps the fallback record when its process cannot be probed', async () => {
    const EXTERNAL_PID = 4711;
    const fallback: OwnedServerRecord = { ...record, port: PORT + 1, pid: 9001, startTime: '777' };
    const registry = createMemoryRegistry(fallback);
    const harness = createHarness({
      portState: (port: number) => (port === PORT ? 'occupied' : 'free'),
      wsl: {
        portOwner: (port: number) => (port === PORT ? EXTERNAL_PID : null),
        probe: (pid: number) => {
          if (pid === EXTERNAL_PID) return backendProbe({ port: PORT });
          throw new Error('probe timed out');
        },
      },
      registry,
      external: createMemoryExternalStore(expectation()),
      attachWaitMs: 30,
      attachPollMs: 5,
    });
    const supervisor = new Supervisor(harness.deps);

    await supervisor.start();

    // A failed probe is not evidence of a dead process: dropping the record
    // would orphan a backend that may still be running as a second writer.
    expect(supervisor.state).toBe('READY');
    expect(lastStatus(harness.statuses).externalBackend).toBe(true);
    expect(registry.read()).toMatchObject({ port: PORT + 1, pid: 9001 });
  });

  it('stops its fallback backend with its own port before serving again', async () => {
    const harness = createHarness({
      portState: 'free',
      // The command line of the running process names the fallback port it was
      // started with, not the port the next start is configured for.
      wsl: {
        probe: (pid: number) =>
          pid === BACKEND_PID ? backendProbe({ port: harness.wsl.lastStartPort() }) : null,
      },
      external: createMemoryExternalStore(expectation()),
      attachWaitMs: 30,
      attachPollMs: 5,
    });
    const supervisor = new Supervisor(harness.deps);
    await supervisor.start();
    expect(harness.wsl.starts[0]?.port).toBe(PORT + 1);

    await supervisor.retry();

    // The process is released while its fallback port is still the active one;
    // otherwise the ownership check reads it as foreign and leaves it behind as
    // a second writer on the same DSH profile.
    expect(supervisor.state).toBe('READY');
    expect(harness.wsl.signals.map((sent) => sent.pid)).toContain(BACKEND_PID);
    expect(harness.wsl.starts).toHaveLength(2);
    expect(harness.wsl.starts[1]?.port).toBe(PORT + 1);
    expect(harness.registry.read()?.port).toBe(PORT + 1);
  });

  it('takes the reserved port back on an explicit restart', async () => {
    const harness = createHarness({
      portState: 'free',
      wsl: {
        probe: (pid: number) =>
          pid === BACKEND_PID ? backendProbe({ port: harness.wsl.lastStartPort() }) : null,
      },
      external: createMemoryExternalStore(expectation()),
      attachWaitMs: 30,
      attachPollMs: 5,
    });
    const supervisor = new Supervisor(harness.deps);
    await supervisor.start();
    expect(harness.wsl.starts[0]?.port).toBe(PORT + 1);

    await supervisor.restart();

    // Restart while nothing is attached is the documented "take the port" action.
    expect(supervisor.state).toBe('READY');
    expect(harness.wsl.starts).toHaveLength(2);
    expect(harness.wsl.starts[1]?.port).toBe(PORT);
    expect(lastStatus(harness.statuses).port).toBe(PORT);
    expect(harness.external.read()).toBeNull();
  });

  it('does not keep a distribution open for a backend it owns', async () => {
    const harness = createHarness({ portState: 'free', attachWaitMs: 30, attachPollMs: 5 });
    const supervisor = new Supervisor(harness.deps);

    await supervisor.start();

    expect(supervisor.state).toBe('READY');
    expect(harness.wsl.keepalives).toEqual([]);
  });

  it('re-attaches by itself when the external backend comes back', async () => {
    let backendUp = true;
    let probesWhileDown = 0;
    const harness = createHarness({
      portState: () => {
        if (backendUp) return 'occupied';
        probesWhileDown += 1;
        if (probesWhileDown < 3) return 'free';
        backendUp = true;
        return 'occupied';
      },
      web: { health: () => (backendUp ? 200 : 401) },
      wsl: externalWsl,
      attachWaitMs: 100,
      attachPollMs: 5,
    });
    const supervisor = new Supervisor(harness.deps);
    await supervisor.start();
    expect(supervisor.state).toBe('READY');

    backendUp = false;
    await supervisor.healthTick();
    await supervisor.healthTick();

    expect(supervisor.state).toBe('READY');
    expect(lastStatus(harness.statuses).externalBackend).toBe(true);
    expect(harness.wsl.starts).toHaveLength(0);
    expect(harness.wsl.signals).toHaveLength(0);
  });

  it('drops an expectation written for other settings', async () => {
    const external = createMemoryExternalStore(expectation(PORT + 10));
    const harness = createHarness({ portState: 'free', external });
    const supervisor = new Supervisor(harness.deps);

    await supervisor.start();

    expect(supervisor.state).toBe('READY');
    expect(harness.wsl.starts).toHaveLength(1);
    expect(external.read()).toBeNull();
  });
});

describe('cold-start discovery of a backend the owner starts', () => {
  const EXTERNAL_PID = 4711;
  const externalWsl = {
    portOwner: EXTERNAL_PID,
    probe: (pid: number) => (pid === EXTERNAL_PID ? backendProbe() : null),
  };

  it('attaches to a backend that takes the free port during the grace window', async () => {
    let probes = 0;
    const harness = createHarness({
      portState: () => (probes++ < 4 ? 'free' : 'occupied'),
      wsl: externalWsl,
      discoveryGraceMs: 100,
      discoveryPollMs: 5,
    });
    const supervisor = new Supervisor(harness.deps);

    await supervisor.start();

    expect(supervisor.state).toBe('READY');
    expect(lastStatus(harness.statuses).externalBackend).toBe(true);
    expect(harness.wsl.starts).toHaveLength(0);
    expect(harness.external.read()).not.toBeNull();
  });

  it('starts its own backend when nothing appears during the grace window', async () => {
    const harness = createHarness({
      portState: 'free',
      discoveryGraceMs: 30,
      discoveryPollMs: 5,
    });
    const supervisor = new Supervisor(harness.deps);

    await supervisor.start();

    expect(supervisor.state).toBe('READY');
    expect(harness.wsl.starts).toHaveLength(1);
    expect(harness.external.read()).toBeNull();
  });

  it('reports a listener that appears but is not this profile\'s backend', async () => {
    let probes = 0;
    const harness = createHarness({
      portState: () => (probes++ < 2 ? 'free' : 'occupied'),
      wsl: {
        portOwner: 9999,
        probe: (pid: number) => (pid === 9999 ? backendProbe({ cmdline: '/usr/bin/python3 -m http.server 3080' }) : null),
      },
      discoveryGraceMs: 100,
      discoveryPollMs: 5,
    });
    const supervisor = new Supervisor(harness.deps);

    await expect(supervisor.start()).rejects.toThrow(/already in use/);
    expect(supervisor.state).toBe('ERROR');
    expect(harness.wsl.starts).toHaveLength(0);
  });
});

describe('external expectation edge cases from review', () => {
  it('keeps the expectation while it reuses the app-owned fallback', async () => {
    const external = createMemoryExternalStore({ distro: 'Ubuntu', port: PORT, recordedAt: '2026-01-01T00:00:00.000Z', misses: 1 });
    const harness = createHarness({ portState: 'occupied', registry: createMemoryRegistry(record), external });
    const supervisor = new Supervisor(harness.deps);

    await supervisor.start();

    expect(supervisor.state).toBe('READY');
    expect(lastStatus(harness.statuses).ownedServer).toBe(true);
    // The port is borrowed until the distribution boots again.
    expect(external.read()?.misses).toBe(1);
  });

  it('attaches even when the profile cannot remember the expectation', async () => {
    const failing = {
      read: () => null,
      write: () => {
        throw new Error('EACCES: read-only profile');
      },
      clear: () => undefined,
      path: () => '/tmp/external-backend.json',
    };
    const harness = createHarness({
      portState: 'occupied',
      external: failing,
      wsl: { portOwner: 4711, probe: (pid: number) => (pid === 4711 ? backendProbe() : null) },
    });
    const supervisor = new Supervisor(harness.deps);

    await supervisor.start();

    expect(supervisor.state).toBe('READY');
    expect(lastStatus(harness.statuses).externalBackend).toBe(true);
    expect(harness.wsl.starts).toHaveLength(0);
  });

  it('checks the port again on the last polling tick instead of sleeping it away', async () => {
    let probes = 0;
    const harness = createHarness({
      portState: () => (probes++ <= 20 ? 'free' : 'occupied'),
      wsl: { portOwner: 4711, probe: (pid: number) => (pid === 4711 ? backendProbe() : null) },
      discoveryGraceMs: 100,
      discoveryPollMs: 5,
    });
    const supervisor = new Supervisor(harness.deps);

    await supervisor.start();

    expect(supervisor.state).toBe('READY');
    expect(lastStatus(harness.statuses).externalBackend).toBe(true);
    expect(harness.wsl.starts).toHaveLength(0);
  });

  it('starts an app-owned backend when the listener leaves during the wait', async () => {
    let probes = 0;
    const harness = createHarness({
      portState: () => (probes++ < 1 ? 'occupied' : 'free'),
      attachWaitMs: 20,
      attachPollMs: 5,
    });
    const supervisor = new Supervisor(harness.deps);

    await supervisor.start();

    expect(supervisor.state).toBe('READY');
    expect(harness.wsl.starts).toHaveLength(1);
    expect(lastStatus(harness.statuses).externalBackend).toBe(false);
  });

  it('does not count a wait that was canceled by quitting as a miss', async () => {
    const external = createMemoryExternalStore({
      distro: 'Ubuntu',
      port: PORT,
      recordedAt: '2026-01-01T00:00:00.000Z',
      misses: 1,
    });
    let probes = 0;
    let supervisor: Supervisor | null = null;
    const harness = createHarness({
      portState: () => {
        if (probes++ === 2) void supervisor?.detach();
        return 'free';
      },
      external,
      attachWaitMs: 20,
      attachPollMs: 5,
    });
    supervisor = new Supervisor(harness.deps);

    await supervisor.start();

    expect(external.read()?.misses).toBe(1);
    expect(harness.wsl.starts).toHaveLength(0);
  });

  it('keeps waiting for a verified backend that cannot answer the session check yet', async () => {
    const external = createMemoryExternalStore({ distro: 'Ubuntu', port: PORT, recordedAt: '2026-01-01T00:00:00.000Z' });
    let healthCalls = 0;
    const harness = createHarness({
      portState: 'occupied',
      external,
      wsl: { portOwner: 4711, probe: (pid: number) => (pid === 4711 ? backendProbe() : null) },
      web: { health: () => (healthCalls++ < 3 ? 500 : 200) },
      attachWaitMs: 100,
      attachPollMs: 5,
    });
    const supervisor = new Supervisor(harness.deps);

    await supervisor.start();

    expect(supervisor.state).toBe('READY');
    expect(lastStatus(harness.statuses).externalBackend).toBe(true);
    expect(harness.wsl.starts).toHaveLength(0);
  });
});
