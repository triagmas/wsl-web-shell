/**
 * Issue #12 — the transaction journal must be fail-loud (review P0-A).
 *
 * The journal is the only record of a swap, so a write that silently fails would
 * let the updater replace a runtime it could not repair after a crash. These
 * tests use the real file-backed store: a write has to be durable and readable
 * back, and an impossible write has to throw instead of being logged away.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createJournalStore, recoverInterruptedUpdate } from '../src/main/core/update-recovery.js';
import { createNullLogger } from '../src/main/core/logger.js';
import {
  UpdateJournalError,
  parseUpdateJournal,
  type RuntimeObservation,
  type UpdateJournal,
} from '../src/main/core/update.js';

const journal = (overrides: Partial<UpdateJournal> = {}): UpdateJournal => ({
  version: 1,
  transaction: '20261107T101500Z-1a2b',
  phase: 'activating',
  distro: 'Ubuntu',
  runtimeRoot: '~/.local/share/wsl-web-shell',
  canonicalRoot: '/home/u/.local/share/wsl-web-shell',
  target: '0.2.2-rc.1',
  installed: '0.2.1-rc.5',
  startedAt: '2026-11-07T10:15:00.000Z',
  updatedAt: '2026-11-07T10:15:04.000Z',
  ...overrides,
});

const directories: string[] = [];

/**
 * POSIX directory permissions are only enforced off Windows and for a normal user
 * (root bypasses them). Elsewhere the unreadable-parent cases cannot be created;
 * an unreadable record is still covered by the EISDIR and dangling-link tests.
 */
const canDenyDirectoryAccess =
  process.platform !== 'win32' && !(typeof process.getuid === 'function' && process.getuid() === 0);

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'wss-journal-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('journal store', () => {
  it('writes a record that can be read back and parsed', async () => {
    const directory = await scratch();
    const path = join(directory, 'profile', 'update-journal.json');
    const store = createJournalStore(path, createNullLogger());

    store.write(journal());
    expect((await stat(path)).isFile()).toBe(true);
    expect(parseUpdateJournal(JSON.parse(await readFile(path, 'utf8')) as unknown)).toEqual(journal());
    expect(store.read()).toEqual(journal());

    store.clear();
    expect(store.read()).toBeNull();
  });

  it('replaces a previous record atomically', async () => {
    const directory = await scratch();
    const path = join(directory, 'update-journal.json');
    const store = createJournalStore(path, createNullLogger());

    store.write(journal({ phase: 'staging' }));
    store.write(journal({ phase: 'activating' }));
    expect(store.read()?.phase).toBe('activating');
    // No temporary file is left behind.
    await expect(stat(`${path}.tmp`)).rejects.toBeTruthy();
  });

  it('throws when the profile cannot be written, instead of ignoring it', async () => {
    const directory = await scratch();
    // A file occupies the profile path, so the directory cannot be created.
    const blocker = join(directory, 'profile');
    await writeFile(blocker, 'not a directory', 'utf8');
    const store = createJournalStore(join(blocker, 'update-journal.json'), createNullLogger());

    expect(() => store.write(journal())).toThrow();
    expect(store.read()).toBeNull();
  });

  it('returns null only when there is no journal at all', async () => {
    const directory = await scratch();
    const store = createJournalStore(join(directory, 'missing', 'update-journal.json'), createNullLogger());
    expect(store.read()).toBeNull();
  });

  it('throws for a corrupt record and keeps the file', async () => {
    const directory = await scratch();
    const path = join(directory, 'update-journal.json');
    await writeFile(path, '{ not json', 'utf8');
    const store = createJournalStore(path, createNullLogger());

    expect(() => store.read()).toThrow(UpdateJournalError);
    try {
      store.read();
    } catch (error) {
      expect((error as UpdateJournalError).reason).toBe('corrupt');
      expect((error as UpdateJournalError).path).toBe(path);
    }
    // The evidence is never deleted by a read.
    expect((await stat(path)).isFile()).toBe(true);
  });

  it('throws for a record that is valid JSON but not a journal', async () => {
    const directory = await scratch();
    const path = join(directory, 'update-journal.json');
    await writeFile(path, JSON.stringify({ version: 1, phase: 'activating' }), 'utf8');
    const store = createJournalStore(path, createNullLogger());

    expect(() => store.read()).toThrow(UpdateJournalError);
    try {
      store.read();
    } catch (error) {
      expect((error as UpdateJournalError).reason).toBe('corrupt');
    }
  });

  it.skipIf(!canDenyDirectoryAccess)('throws for a record whose parent directory cannot be read', async () => {
    const directory = await scratch();
    const profile = join(directory, 'profile');
    await mkdir(profile);
    const path = join(profile, 'update-journal.json');
    await writeFile(path, JSON.stringify(journal()), 'utf8');
    await chmod(profile, 0o000);
    try {
      const store = createJournalStore(path, createNullLogger());
      // The record exists but cannot be inspected: never "absent".
      let thrown: unknown = null;
      try {
        store.read();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(UpdateJournalError);
      expect((thrown as UpdateJournalError).reason).toBe('unreadable');
      expect((thrown as UpdateJournalError).message).toContain('EACCES');
    } finally {
      await chmod(profile, 0o700);
    }
  });

  it('throws for a link whose target is missing', async () => {
    const directory = await scratch();
    const path = join(directory, 'update-journal.json');
    await symlink(join(directory, 'gone.json'), path);

    const store = createJournalStore(path, createNullLogger());
    let thrown: unknown = null;
    try {
      store.read();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UpdateJournalError);
    expect((thrown as UpdateJournalError).reason).toBe('unreadable');
    expect((thrown as UpdateJournalError).message).toContain('linked file does not exist');
    // The link is kept: it is evidence of what happened in the profile.
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
  });

  it('reads a record through a valid link', async () => {
    const directory = await scratch();
    const target = join(directory, 'real-journal.json');
    await writeFile(target, JSON.stringify(journal({ phase: 'staging' })), 'utf8');
    const path = join(directory, 'update-journal.json');
    await symlink(target, path);

    const store = createJournalStore(path, createNullLogger());
    expect(store.read()?.phase).toBe('staging');
  });

  it('throws for an unreadable record', async () => {
    const directory = await scratch();
    const path = join(directory, 'update-journal.json');
    // A directory where the file should be: the file exists but cannot be read.
    await mkdir(path);

    const store = createJournalStore(path, createNullLogger());
    let thrown: unknown = null;
    try {
      store.read();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UpdateJournalError);
    expect((thrown as UpdateJournalError).reason).toBe('unreadable');
  });
});

describe('start-up handling of the journal states (R12.3)', () => {
  const observation: RuntimeObservation = {
    runtimePresent: true,
    runtimeVersion: '0.2.1-rc.5',
    previous: null,
    stage: null,
  };

  function deps(store: ReturnType<typeof createJournalStore>, calls: string[]) {
    return {
      wsl: {
        async inspectRuntime() {
          calls.push('inspect');
          return observation;
        },
        async restoreRuntime() {
          calls.push('restore');
          return { code: 0, tail: 'update: rollout reverted' };
        },
      },
      journal: store,
      resume: async () => {
        calls.push('resume');
        return { ok: true, message: null };
      },
      log: createNullLogger(),
    };
  }

  it('starts normally when no journal exists', async () => {
    const directory = await scratch();
    const store = createJournalStore(join(directory, 'update-journal.json'), createNullLogger());
    const calls: string[] = [];
    const result = await recoverInterruptedUpdate(deps(store, calls));
    expect(result).toEqual({ handled: false, action: null, message: null });
    expect(calls).toEqual([]);
  });

  it('blocks the start and keeps the file when the journal is corrupt', async () => {
    const directory = await scratch();
    const path = join(directory, 'update-journal.json');
    await writeFile(path, 'garbage', 'utf8');
    const store = createJournalStore(path, createNullLogger());
    const calls: string[] = [];

    const result = await recoverInterruptedUpdate(deps(store, calls));
    expect(result.handled).toBe(true);
    expect(result.action).toBe('blocked');
    expect(result.message).toContain('corrupt');
    expect(result.message).toContain(path);
    expect(result.message).toContain('was not started');
    // DeepSeek Harness is never started and nothing is inspected or restored.
    expect(calls).toEqual([]);
    expect((await stat(path)).isFile()).toBe(true);
  });

  it.skipIf(!canDenyDirectoryAccess)(
    'blocks the start when the journal sits behind an unreadable directory',
    async () => {
    const directory = await scratch();
    const profile = join(directory, 'profile');
    await mkdir(profile);
    const path = join(profile, 'update-journal.json');
    await writeFile(path, JSON.stringify(journal()), 'utf8');
    await chmod(profile, 0o000);
    try {
      const calls: string[] = [];
      const result = await recoverInterruptedUpdate(
        deps(createJournalStore(path, createNullLogger()), calls),
      );
      expect(result.action).toBe('blocked');
      expect(result.message).toContain('unreadable');
      expect(calls).toEqual([]);
    } finally {
      await chmod(profile, 0o700);
    }
    },
  );

  it('blocks the start when the journal is a broken link', async () => {
    const directory = await scratch();
    const path = join(directory, 'update-journal.json');
    await symlink(join(directory, 'gone.json'), path);
    const calls: string[] = [];

    const result = await recoverInterruptedUpdate(
      deps(createJournalStore(path, createNullLogger()), calls),
    );
    expect(result.action).toBe('blocked');
    expect(result.message).toContain('linked file does not exist');
    expect(result.message).toContain('was not started');
    expect(calls).toEqual([]);
  });

  it('blocks the start and keeps the file when the journal is unreadable', async () => {
    const directory = await scratch();
    const path = join(directory, 'update-journal.json');
    await mkdir(path);
    const store = createJournalStore(path, createNullLogger());
    const calls: string[] = [];

    const result = await recoverInterruptedUpdate(deps(store, calls));
    expect(result.action).toBe('blocked');
    expect(result.message).toContain('unreadable');
    expect(result.message).toContain('was not started');
    expect(calls).toEqual([]);
  });
});
