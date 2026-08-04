import type { Database } from '@nocobase/database';
import { describe, expect, it } from 'vitest';
import {
  PathLockService,
  lockPathsOverlap,
  normalizeLockPath,
  pathSetsOverlap,
  waitGraphHasCycle,
} from '../services/PathLockService';

type Row = Record<string, unknown>;

class MemoryRepository {
  private nextId = 1;

  constructor(readonly rows: Row[] = []) {}

  async find(options: Row = {}) {
    const filter = (options.filter as Row | undefined) || {};
    return this.rows.filter((row) => Object.entries(filter).every(([key, value]) => row[key] === value));
  }

  async findOne(options: Row) {
    if (options.filterByTk !== undefined) return this.rows.find((row) => row.id === options.filterByTk) || null;
    return (await this.find(options))[0] || null;
  }

  async create(options: Row) {
    const row = { id: this.nextId++, ...((options.values as Row | undefined) || {}) };
    this.rows.push(row);
    return row;
  }

  async update(options: Row) {
    const values = (options.values as Row | undefined) || {};
    for (const row of this.rows) {
      if (row.id === options.filterByTk) Object.assign(row, values);
    }
  }
}

function createService(rows: Row[] = []) {
  const locks = new MemoryRepository(rows);
  const database = {
    getRepository(name: string) {
      if (name !== 'agentLoopPathLocks') throw new Error(`Unexpected repository ${name}`);
      return locks;
    },
    sequelize: {
      // Writes made inside a transaction that throws must disappear, otherwise a test cannot tell
      // an audit write that commits from one that is rolled back with the error that follows it.
      async transaction<T>(callback: (value: { LOCK: { UPDATE: string } }) => Promise<T>) {
        const snapshot = structuredClone(locks.rows);
        try {
          return await callback({ LOCK: { UPDATE: 'UPDATE' } });
        } catch (error) {
          locks.rows.splice(0, locks.rows.length, ...snapshot);
          throw error;
        }
      },
    },
  };
  const distributedLock = { runExclusive: <T>(_key: string, operation: () => Promise<T>) => operation() };
  return { locks, service: new PathLockService(database as unknown as Database, distributedLock) };
}

describe('PathLockService primitives', () => {
  it('compares repository paths by segment instead of string prefix', () => {
    expect(lockPathsOverlap('src/a/**', 'src/a/tests/**')).toBe(true);
    expect(lockPathsOverlap('src/a/**', 'src/ab/**')).toBe(false);
    expect(lockPathsOverlap('packages/*/src/**', 'packages/plugin-a/src/file.ts')).toBe(true);
    expect(pathSetsOverlap(['src/a/**', 'docs/**'], ['src/ab/**', 'tests/**'])).toBe(false);
  });

  it('rejects paths outside the repository namespace', () => {
    expect(() => normalizeLockPath('../secret')).toThrow('dot segments');
    expect(() => normalizeLockPath('/absolute/path')).toThrow('repository-relative');
    expect(() => normalizeLockPath('C:/absolute/path')).toThrow('repository-relative');
  });

  it('detects waiter cycles without treating a normal wait chain as deadlock', () => {
    const waiting = [
      {
        id: 1,
        runId: 1,
        repositoryKey: 'repo',
        paths: ['src/a/**'],
        status: 'waiting' as const,
        blockerRunIds: [2],
      },
      {
        id: 2,
        runId: 2,
        repositoryKey: 'repo',
        paths: ['src/b/**'],
        status: 'waiting' as const,
        blockerRunIds: [3],
      },
    ];
    expect(waitGraphHasCycle(waiting, 3, [4])).toBe(false);
    expect(waitGraphHasCycle(waiting, 3, [1])).toBe(true);
  });
});

describe('PathLockService TTL enforcement', () => {
  it('expires a held lock past its TTL instead of treating it as a blocker', async () => {
    const { locks, service } = createService([
      {
        id: 1,
        runId: 1,
        repositoryKey: 'repo',
        owner: 'worker-dead',
        paths: ['src/a/**'],
        status: 'held',
        blockerRunIds: [],
        expiresAt: new Date(Date.now() - 1_000),
      },
    ]);

    const result = await service.acquire({
      runId: 2,
      repositoryKey: 'repo',
      owner: 'worker-b',
      paths: ['src/a/file.ts'],
      ttlMs: 60_000,
    });

    expect(result.acquired).toBe(true);
    expect(locks.rows[0]).toMatchObject({ id: 1, status: 'expired' });
    expect(locks.rows[1]).toMatchObject({ runId: 2, status: 'held', owner: 'worker-b' });
  });

  it('keeps an unexpired held lock as a blocker for an overlapping path', async () => {
    const { locks, service } = createService([
      {
        id: 1,
        runId: 1,
        repositoryKey: 'repo',
        owner: 'worker-a',
        paths: ['src/a/**'],
        status: 'held',
        blockerRunIds: [],
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);

    const result = await service.acquire({
      runId: 2,
      repositoryKey: 'repo',
      owner: 'worker-b',
      paths: ['src/a/file.ts'],
      ttlMs: 60_000,
    });

    expect(result).toMatchObject({ acquired: false, deadlocked: false, blockers: [1] });
    expect(locks.rows[0].status).toBe('held');
    expect(locks.rows[1]).toMatchObject({ runId: 2, status: 'waiting', blockerRunIds: [1] });
  });

  it('refuses to renew a lock whose TTL already lapsed', async () => {
    const { locks, service } = createService([
      {
        id: 1,
        runId: 1,
        repositoryKey: 'repo',
        owner: 'worker-a',
        paths: ['src/a/**'],
        status: 'held',
        blockerRunIds: [],
        expiresAt: new Date(Date.now() - 1),
      },
    ]);

    await expect(service.renew(1, 'repo', 60_000, 'worker-a')).rejects.toThrow('expired');
    // The `expired` mark must survive the error. It is only durable because the audit write commits
    // in its own transaction; writing it in the transaction that throws would roll it back to `held`.
    expect(locks.rows[0].status).toBe('expired');
    expect(locks.rows[0].blockerRunIds).toEqual([]);
  });

  it('rejects a release from a worker that no longer owns the lock and keeps it held', async () => {
    const { locks, service } = createService([
      {
        id: 1,
        runId: 1,
        repositoryKey: 'repo',
        owner: 'worker-a',
        paths: ['src/a/**'],
        status: 'held',
        blockerRunIds: [],
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);

    // worker-b reclaimed the run and now owns the lock; the stale worker-a must not free it.
    await expect(service.release(1, 'repo', 'worker-b')).resolves.toBe(false);
    expect(locks.rows[0].status).toBe('held');

    await expect(service.release(1, 'repo', 'worker-a')).resolves.toBe(true);
    expect(locks.rows[0].status).toBe('released');
  });

  it('rejects a renew from a worker that no longer owns the lock', async () => {
    const { service } = createService([
      {
        id: 1,
        runId: 1,
        repositoryKey: 'repo',
        owner: 'worker-a',
        paths: ['src/a/**'],
        status: 'held',
        blockerRunIds: [],
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);

    await expect(service.renew(1, 'repo', 60_000, 'worker-b')).rejects.toThrow('no longer owned');
  });

  it('reuses an existing held lock only for the same owner and paths', async () => {
    const { locks, service } = createService([
      {
        id: 1,
        runId: 1,
        repositoryKey: 'repo',
        owner: 'worker-a',
        paths: ['src/a/**'],
        status: 'held',
        blockerRunIds: [],
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);

    await expect(
      service.acquire({ runId: 1, repositoryKey: 'repo', owner: 'worker-a', paths: ['src/a/**'], ttlMs: 60_000 }),
    ).resolves.toMatchObject({ acquired: true });
    expect(locks.rows).toHaveLength(1);

    // A different owner token means the previous worker's lease is gone; the row is re-taken
    // rather than silently shared.
    await expect(
      service.acquire({ runId: 1, repositoryKey: 'repo', owner: 'worker-b', paths: ['src/a/**'], ttlMs: 60_000 }),
    ).resolves.toMatchObject({ acquired: true });
    expect(locks.rows).toHaveLength(1);
    expect(locks.rows[0].owner).toBe('worker-b');
  });

  it('rejects a non-positive TTL', async () => {
    const { service } = createService();
    await expect(
      service.acquire({ runId: 1, repositoryKey: 'repo', owner: 'worker-a', paths: ['src/a/**'], ttlMs: 0 }),
    ).rejects.toThrow('positive number of milliseconds');
  });
});
