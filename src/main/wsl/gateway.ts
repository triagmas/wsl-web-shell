/** Real `wsl.exe` gateway used by the Electron main process. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  WslGateway,
  ServerHandle,
  StartServerRequest,
  ExitInfo,
  UpdateRunResult,
} from '../core/supervisor.js';
import type { RuntimeObservation } from '../core/update.js';
import { ShellError } from '../core/supervisor.js';
import type { Logger } from '../core/logger.js';
import type { ProcessProbe } from './output.js';
import { parseDshVersion } from '../core/versions.js';
import {
  decodeWslOutput,
  LineBuffer,
  parseDistroList,
  parsePidMarker,
  parseProcessProbe,
  parseRuntimeProbe,
  stripAnsi,
} from './output.js';
import {
  WSL_EXE,
  buildDistroProbeArgs,
  buildDshPathCheckArgs,
  buildDshVersionArgs,
  buildListDistrosArgs,
  buildPrepareIsolationArgs,
  buildProbeProcessArgs,
  buildResolveRuntimeArgs,
  buildSignalArgs,
  buildStartServerArgs,
} from './args.js';
import {
  buildActivateArgs,
  buildInspectArgs,
  buildNpmViewArgs,
  buildRestoreArgs,
  buildStageArgs,
  NPM_MARKER,
  parseInspectLine,
  parseNpmMarker,
} from './update-args.js';

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface WslGatewayOptions {
  log: Logger;
  wslExe?: string;
  spawnImpl?: typeof spawn;
}

export function createWslGateway(options: WslGatewayOptions): WslGateway {
  const wslExe = options.wslExe ?? WSL_EXE;
  const spawnImpl = options.spawnImpl ?? spawn;

  const run = (args: string[], timeoutMs: number): Promise<CommandResult> =>
    new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        // stdio[0] is 'ignore', so stdin is null; stdout/stderr are piped.
        child = spawnImpl(wslExe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as ChildProcessWithoutNullStreams;
      } catch (error) {
        reject(error);
        return;
      }
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new ShellError('unexpected', 'A WSL command timed out.', 'The distribution may be unresponsive.'));
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
      child.once('error', (error: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error.code === 'ENOENT') {
          reject(
            new ShellError(
              'wsl-missing',
              'Windows Subsystem for Linux (wsl.exe) was not found.',
              'Install WSL with "wsl --install" and restart Windows, then relaunch this app.',
            ),
          );
          return;
        }
        reject(error);
      });
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          code,
          stdout: stripAnsi(decodeWslOutput(Buffer.concat(stdoutChunks))),
          stderr: stripAnsi(decodeWslOutput(Buffer.concat(stderrChunks))),
        });
      });
    });

  /**
   * Run one long updater step, streaming every line to the modal window.
   *
   * The child gets no TTY and its output is treated as data: escapes and secrets
   * are removed by the terminal buffer, while the last lines are kept here so a
   * failure can explain itself.
   */
  const spawnStreaming = (
    argv: string[],
    onLine: (line: string) => void,
    label: string,
  ): Promise<UpdateRunResult> =>
    new Promise((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawnImpl(wslExe, argv, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, WSL_UTF8: '1' },
        }) as unknown as ChildProcessWithoutNullStreams;
      } catch (error) {
        options.log.error(`${label} failed to spawn: ${error instanceof Error ? error.message : 'unknown'}`);
        resolve({ code: null, tail: `${label} could not be started.` });
        return;
      }
      const stdoutBuffer = new LineBuffer();
      const stderrBuffer = new LineBuffer();
      const tail: string[] = [];
      const emit = (line: string): void => {
        const clean = stripAnsi(line);
        if (clean.trim() === '') return;
        tail.push(clean);
        if (tail.length > 20) tail.shift();
        onLine(clean);
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        for (const line of stdoutBuffer.push(chunk)) emit(line);
      });
      child.stderr.on('data', (chunk: string) => {
        for (const line of stderrBuffer.push(chunk)) emit(line);
      });
      child.once('error', (error: NodeJS.ErrnoException) => {
        options.log.error(`${label} error: ${error.code ?? error.message}`);
        resolve({ code: null, tail: tail.slice(-2).join(' ') || `${label} failed to start.` });
      });
      child.once('close', (code) => {
        for (const line of stdoutBuffer.flush()) emit(line);
        for (const line of stderrBuffer.flush()) emit(line);
        resolve({ code, tail: tail.slice(-2).join(' ') });
      });
    });

  const ensureSuccess = (result: CommandResult, message: string): CommandResult => {
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().split('\n').slice(-2).join(' ');
      throw new ShellError('unexpected', message, detail === '' ? null : detail);
    }
    return result;
  };

  return {
    async listDistros() {
      const result = await run(buildListDistrosArgs(), 30_000);
      if (result.code !== 0) {
        throw new ShellError(
          'wsl-missing',
          'WSL did not report any distributions.',
          (result.stderr || result.stdout).trim() || 'Run "wsl --install" and try again.',
        );
      }
      return parseDistroList(result.stdout);
    },

    async ensureDistro(distro) {
      try {
        ensureSuccess(await run(buildDistroProbeArgs(distro), 60_000), `Could not start the WSL distribution "${distro}".`);
      } catch (error) {
        if (error instanceof ShellError && error.code === 'unexpected') {
          throw new ShellError(
            'distro-missing',
            `Could not start the WSL distribution "${distro}".`,
            error.hint ?? 'Open the distribution once in Windows Terminal and try again.',
          );
        }
        throw error;
      }
      options.log.info(`wsl distribution ready: ${distro}`);
    },

    async prepareIsolation(distro, root) {
      const result = await run(buildPrepareIsolationArgs(distro, root), 30_000);
      if (result.code !== 0) {
        throw new ShellError(
          'unexpected',
          'The isolated backend environment could not be created inside WSL.',
          (result.stderr || result.stdout).trim().split('\n').slice(-2).join(' ') || 'Check permissions of the runtime root in Settings.',
        );
      }
      options.log.info(`isolated environment ready: ${result.stdout.trim().split('\n').pop() ?? root}`);
    },

    async resolveRuntime(distro, override, isolationRoot) {
      const result = await run(buildResolveRuntimeArgs(distro, isolationRoot), 30_000);
      const probe = parseRuntimeProbe(result.stdout);
      if (probe.nodePath !== null) options.log.info(`node runtime: ${probe.nodePath}`);

      if (override !== null) {
        const check = await run(buildDshPathCheckArgs(distro, override), 20_000);
        if (check.code === 0) {
          options.log.info(`dsh (configured): ${override}`);
          return { dshPath: override, nodePath: probe.nodePath, canonicalRoot: probe.rootPath };
        }
        throw new ShellError(
          'dsh-missing',
          `The configured DeepSeek Harness path is not executable: ${override}`,
          'Update the path in Settings.',
        );
      }

      if (probe.dshPath === null) {
        throw new ShellError(
          'dsh-missing',
          'DeepSeek Harness CLI (dsh) was not found inside the WSL distribution.',
          'Install it into the isolated runtime (npm install --prefix ~/.local/share/wsl-web-shell/runtime -g @deepseek-ai/dsh) or set the executable path in Settings. This app never installs packages automatically.',
        );
      }
      const check = await run(buildDshPathCheckArgs(distro, probe.dshPath), 20_000);
      if (check.code !== 0) {
        throw new ShellError('dsh-missing', 'The detected DeepSeek Harness CLI is not executable.', 'Set the executable path in Settings.');
      }
      options.log.info(`dsh resolved: ${probe.dshPath}`);
      if (probe.rootPath !== null) options.log.info(`isolation root (canonical): ${probe.rootPath}`);
      return { dshPath: probe.dshPath, nodePath: probe.nodePath, canonicalRoot: probe.rootPath };
    },

    startServer(request: StartServerRequest): ServerHandle {
      const argv = buildStartServerArgs(request);
      options.log.info(`starting backend: ${argv.slice(0, 4).join(' ')} (port=${request.port})`);
      const child = spawnImpl(wslExe, argv, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, WSL_UTF8: '1' },
      }) as unknown as ChildProcessWithoutNullStreams;

      const collected: string[] = [];
      const listeners = new Set<(line: string) => void>();
      const stdoutBuffer = new LineBuffer();
      const stderrBuffer = new LineBuffer();
      let stderrTail = '';
      let resolvePid: (pid: number | null) => void = () => undefined;
      const pidPromise = new Promise<number | null>((resolve) => {
        resolvePid = resolve;
      });
      let pidSettled = false;

      const emit = (line: string): void => {
        if (line === '') return;
        collected.push(line);
        if (collected.length > 2000) collected.splice(0, collected.length - 2000);
        if (!pidSettled) {
          const marker = parsePidMarker(line);
          if (marker !== null) {
            pidSettled = true;
            resolvePid(marker);
          }
        }
        for (const listener of listeners) listener(line);
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        for (const line of stdoutBuffer.push(chunk)) emit(stripAnsi(line));
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderrTail = `${stderrTail}${stripAnsi(chunk)}`.slice(-4000);
        for (const line of stderrBuffer.push(chunk)) emit(`[stderr] ${stripAnsi(line)}`);
      });

      const exited = new Promise<ExitInfo>((resolve) => {
        child.once('error', (error: NodeJS.ErrnoException) => {
          if (!pidSettled) {
            pidSettled = true;
            resolvePid(null);
          }
          options.log.error(`backend spawn failed: ${error.code ?? error.message}`);
          resolve({ code: null, signal: null });
        });
        child.once('close', (code, signal) => {
          if (!pidSettled) {
            pidSettled = true;
            resolvePid(null);
          }
          for (const line of stdoutBuffer.flush()) emit(stripAnsi(line));
          for (const line of stderrBuffer.flush()) emit(`[stderr] ${stripAnsi(line)}`);
          resolve({ code: code ?? null, signal: signal ?? null });
        });
      });

      return {
        pid: pidPromise,
        lines: () => [...collected],
        onLine(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        exited,
        async stop() {
          if (child.exitCode !== null || child.signalCode !== null) return;
          child.kill();
          await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3_000))]);
        },
        stderrTail: () => stderrTail,
      };
    },

    async checkPublishedVersion(request) {
      const result = await run(
        buildNpmViewArgs({
          distro: request.distro,
          isolationRoot: request.isolationRoot,
          version: request.version,
          nodePath: request.nodePath,
        }),
        120_000,
      );
      const lines = `${result.stdout}\n${result.stderr}`.split('\n');
      const npmPath = lines.map((line) => parseNpmMarker(line)).find((value) => value !== null) ?? null;
      const reported = parseDshVersion(lines.filter((line) => !line.includes(NPM_MARKER)).join('\n'));
      if (npmPath === null) {
        return {
          found: false,
          npmPath: null,
          reported: null,
          message: 'npm was not found in this distribution, so nothing can be verified or installed.',
        };
      }
      if (result.code !== 0 || reported === null) {
        const detail = (result.stderr || result.stdout)
          .split('\n')
          .filter((line) => !line.includes(NPM_MARKER))
          .map((line) => line.trim())
          .filter((line) => line !== '')
          .slice(-1)
          .join(' ');
        return {
          found: false,
          npmPath,
          reported,
          message: detail === '' ? 'npm did not report this version.' : detail,
        };
      }
      return { found: reported === request.version, npmPath, reported, message: null };
    },

    async stageRuntime(request, onLine) {
      const argv = buildStageArgs(
        {
          distro: request.distro,
          isolationRoot: request.isolationRoot,
          version: request.version,
          nodePath: request.nodePath,
        },
        request.npmPath,
        request.transaction,
      );
      options.log.info(`staging DSH ${request.version} (distro=${request.distro}, tx=${request.transaction})`);
      return await spawnStreaming(argv, onLine, 'the update process');
    },

    async activateRuntime(request, onLine) {
      const argv = buildActivateArgs(
        {
          distro: request.distro,
          isolationRoot: request.isolationRoot,
          version: request.version,
          nodePath: request.nodePath,
        },
        request.transaction,
      );
      options.log.info(`activating DSH ${request.version} (tx=${request.transaction})`);
      return await spawnStreaming(argv, onLine, 'the activation process');
    },

    async restoreRuntime(request, onLine) {
      const argv = buildRestoreArgs(request.distro, request.isolationRoot, request.transaction, request.nodePath);
      options.log.warn(`restoring the previous DSH installation (tx=${request.transaction})`);
      return await spawnStreaming(argv, onLine, 'the rollback process');
    },

    async inspectRuntime(distro, isolationRoot) {
      const result = await run(buildInspectArgs(distro, isolationRoot), 30_000);
      const report: RuntimeObservation = {
        runtimePresent: false,
        runtimeVersion: null,
        previous: null,
        stage: null,
      };
      for (const line of `${result.stdout}\n${result.stderr}`.split('\n')) {
        const entry = parseInspectLine(line);
        if (entry === null) continue;
        if (entry.key === 'runtime') report.runtimePresent = entry.value === 'present';
        else if (entry.key === 'version') report.runtimeVersion = entry.value === '' ? null : entry.value;
        else if (entry.key === 'previous') report.previous = entry.value;
        else if (entry.key === 'stage') report.stage = entry.value;
      }
      if (result.code !== 0) {
        options.log.warn(`runtime inspection failed (code=${result.code ?? 'null'})`);
      }
      return report;
    },

    async dshVersion(distro: string, dshPath: string, nodePath: string | null = null): Promise<string | null> {
      const result = await run(buildDshVersionArgs(distro, dshPath, nodePath), 15_000);
      if (result.code !== 0) {
        options.log.warn(`dsh --version did not report a version (code=${result.code ?? 'null'})`);
        // One stderr line is enough to tell a missing runtime from a bad CLI.
        const tail = (result.stderr || result.stdout).trim().split('\n').pop();
        if (tail !== undefined && tail !== '') options.log.debug(`dsh --version output: ${tail}`);
        return null;
      }
      const parsed = parseDshVersion(`${result.stdout}\n${result.stderr}`);
      if (parsed === null) options.log.warn('dsh --version output was not recognised');
      return parsed;
    },

    async probeProcess(distro: string, pid: number): Promise<ProcessProbe | null> {
      const result = await run(buildProbeProcessArgs(distro, pid), 10_000);
      if (result.code !== 0) return null;
      return parseProcessProbe(result.stdout);
    },

    async signal(distro, pid, signal) {
      const result = await run(buildSignalArgs(distro, pid, signal), 10_000);
      if (result.code !== 0) {
        options.log.warn(`signal ${signal} to pid ${pid} was not delivered (code=${result.code ?? 'null'})`);
      }
    },
  };
}
