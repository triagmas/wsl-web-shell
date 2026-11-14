/**
 * Visible console runner (beta.13).
 *
 * The console is the only place the app executes anything for an update, so the
 * tests pin the two facts that keep it usable: the Windows window is shown on
 * purpose (`windowsHide: false`, no `detached`) and the script arrives base64
 * encoded, which keeps stdin a TTY for `sudo` and the closing prompt.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { buildConsoleArgs, runInConsole } from '../src/main/wsl/console.js';

const SCRIPT = '#!/bin/bash\nsudo systemctl stop dsh-web.service\n';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { exit: (code: number | null) => void };
  child.exit = (code) => child.emit('exit', code);
  return child;
}

describe('console arguments', () => {
  it('encodes the script so nothing is left for a shell to reinterpret', () => {
    const args = buildConsoleArgs('Ubuntu', SCRIPT);
    expect(args.slice(0, 4)).toEqual(['-d', 'Ubuntu', '--exec', '/bin/bash']);
    expect(args[4]).toBe('-c');
    const command = args[5] ?? '';
    const encoded = Buffer.from(SCRIPT, 'utf8').toString('base64');
    expect(command).toContain(encoded);
    // `eval "$(...)"` keeps stdin on the console; `... | bash` would replace it
    // with a pipe and break both sudo and the final prompt.
    expect(command.startsWith('eval "$(echo ')).toBe(true);
    expect(command).not.toContain(SCRIPT);
  });

  it('refuses a distro name that is not a plain one', () => {
    expect(() => buildConsoleArgs('Ubuntu; rm -rf /', SCRIPT)).toThrow();
  });
});

describe('runner', () => {
  it('waits for the exit event and reports its code', async () => {
    const child = fakeChild();
    const calls: { exe: string; args: string[]; options: Record<string, unknown> }[] = [];
    const spawnImpl = ((exe: string, args: string[], options: Record<string, unknown>) => {
      calls.push({ exe, args, options });
      setTimeout(() => child.exit(3), 0);
      return child;
    }) as unknown as typeof import('node:child_process').spawn;

    const result = await runInConsole({ distro: 'Ubuntu', script: SCRIPT, spawnImpl });
    expect(result).toEqual({ code: 3 });
    expect(calls[0]?.exe).toBe('wsl.exe');
    // beta.12: `detached` is what opened an unwanted console window.
    expect(calls[0]?.options).toMatchObject({ windowsHide: false, stdio: 'ignore' });
    expect(calls[0]?.options.detached).toBeUndefined();
  });

  it('reports a console that could not be started instead of throwing', async () => {
    const spawnImpl = (() => {
      throw new Error('wsl.exe missing');
    }) as unknown as typeof import('node:child_process').spawn;
    expect(await runInConsole({ distro: 'Ubuntu', script: SCRIPT, spawnImpl })).toEqual({ code: null });
  });

  it('reports a console closed without an exit code', async () => {
    const child = fakeChild();
    const spawnImpl = ((_exe: string, _args: string[], _options: unknown) => {
      setTimeout(() => child.exit(null), 0);
      return child;
    }) as unknown as typeof import('node:child_process').spawn;
    expect(await runInConsole({ distro: 'Ubuntu', script: SCRIPT, spawnImpl })).toEqual({ code: null });
  });
});
