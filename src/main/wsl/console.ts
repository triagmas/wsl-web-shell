/**
 * The visible WSL console a console update runs in (beta.13).
 *
 * Electron-free on purpose: the tests inject a process runner, and the main
 * process passes the real `spawn`. The window is Windows Terminal because the
 * app itself is a GUI program with no console of its own; `windowsHide` stays
 * false and `detached` stays off (beta.12: `detached` maps to DETACHED_PROCESS,
 * which breaks console and window behaviour).
 */
import { spawn } from 'node:child_process';
import { assertDistroName } from './args.js';

export interface ConsoleOptions {
  distro: string;
  /** The whole `bash` script; it is passed base64-encoded, never as free text. */
  script: string;
  wslExe?: string;
  spawnImpl?: typeof spawn;
}

export interface ConsoleExit {
  /** Script exit status, `null` when the console never started or was killed. */
  code: number | null;
}

/**
 * Run the script in a console window and wait for it to exit.
 *
 * `eval "$(echo <base64> | base64 -d)"` is the one form that both survives
 * `wsl.exe` argument quoting and keeps the process stdin on the console TTY,
 * which `sudo` and the closing prompt need. Piping into `bash` would hand it a
 * pipe instead and break both.
 */
export function buildConsoleArgs(distro: string, script: string): string[] {
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  return ['-d', assertDistroName(distro), '--exec', '/bin/bash', '-c', `eval "$(echo '${encoded}' | base64 -d)"`];
}

export function runInConsole(options: ConsoleOptions): Promise<ConsoleExit> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const wslExe = options.wslExe ?? 'wsl.exe';
  const args = buildConsoleArgs(options.distro, options.script);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(wslExe, args, { windowsHide: false, stdio: 'ignore' });
    } catch {
      resolve({ code: null });
      return;
    }
    child.on('error', () => resolve({ code: null }));
    child.on('exit', (code) => resolve({ code: code ?? null }));
  });
}
