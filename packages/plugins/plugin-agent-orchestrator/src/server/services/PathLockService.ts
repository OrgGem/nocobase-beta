import type { Database, Model, Transaction } from '@nocobase/database';

type DistributedLock = {
  runExclusive<T>(key: string, operation: () => Promise<T>, ttl?: number): Promise<T>;
};

type PathLockRow = {
  id: number;
  runId: number;
  repositoryKey: string;
  paths: string[];
  status: 'waiting' | 'held' | 'released' | 'expired';
  blockerRunIds: number[];
};

export type PathLockAcquisition =
  | { acquired: true; lock: PathLockRow; blockers: number[] }
  | { acquired: false; deadlocked: boolean; blockers: number[] };

function read(record: Model | Record<string, unknown>, key: string) {
  const model = record as Model & { get?: (name: string) => unknown };
  return typeof model.get === 'function' ? model.get(key) : (record as Record<string, unknown>)[key];
}

function positiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

// A held lock without a readable expiry is treated as expired: a crashed worker must never
// leave a row that blocks every later run forever.
function lockIsExpired(record: Model | Record<string, unknown>, now: Date) {
  const expiresAt = asDate(read(record, 'expiresAt'));
  return !expiresAt || expiresAt.getTime() <= now.getTime();
}

function positiveTtl(ttlMs: number) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error('Path lock TTL must be a positive number of milliseconds.');
  }
  return ttlMs;
}

export function normalizeLockPath(value: string) {
  const normalized = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) {
    throw new Error(`Lock path must be repository-relative: ${value}`);
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    throw new Error(`Lock path cannot contain dot segments: ${value}`);
  }
  return normalized.replace(/\/$/, '');
}

function literalPrefix(pattern: string) {
  const result: string[] = [];
  for (const segment of normalizeLockPath(pattern).split('/')) {
    if (/[*?{[\]]/.test(segment)) break;
    result.push(segment);
  }
  return result;
}

export function lockPathsOverlap(left: string, right: string) {
  const leftNormalized = normalizeLockPath(left);
  const rightNormalized = normalizeLockPath(right);
  if (leftNormalized === rightNormalized) return true;

  const leftPrefix = literalPrefix(leftNormalized);
  const rightPrefix = literalPrefix(rightNormalized);
  if (leftPrefix.length === 0 || rightPrefix.length === 0) return true;
  const shared = Math.min(leftPrefix.length, rightPrefix.length);
  for (let index = 0; index < shared; index += 1) {
    if (leftPrefix[index] !== rightPrefix[index]) return false;
  }

  const leftHasPattern = leftPrefix.length < leftNormalized.split('/').length;
  const rightHasPattern = rightPrefix.length < rightNormalized.split('/').length;
  if (leftHasPattern || rightHasPattern) return true;
  return leftPrefix.length !== rightPrefix.length;
}

export function pathSetsOverlap(left: string[], right: string[]) {
  return left.some((leftPath) => right.some((rightPath) => lockPathsOverlap(leftPath, rightPath)));
}

function row(record: Model | Record<string, unknown>): PathLockRow {
  const status = read(record, 'status');
  return {
    id: positiveInteger(read(record, 'id')) || 0,
    runId: positiveInteger(read(record, 'runId')) || 0,
    repositoryKey: String(read(record, 'repositoryKey') || ''),
    paths: Array.isArray(read(record, 'paths')) ? (read(record, 'paths') as string[]) : [],
    status: status === 'held' || status === 'released' || status === 'expired' ? status : 'waiting',
    blockerRunIds: Array.isArray(read(record, 'blockerRunIds'))
      ? (read(record, 'blockerRunIds') as unknown[])
          .map(positiveInteger)
          .filter((value): value is number => value !== null)
      : [],
  };
}

export function waitGraphHasCycle(rows: PathLockRow[], runId: number, blockers: number[]) {
  const graph = new Map<number, number[]>();
  for (const lock of rows) {
    if (lock.status === 'waiting') graph.set(lock.runId, lock.blockerRunIds);
  }
  graph.set(runId, blockers);
  const visiting = new Set<number>();
  const visited = new Set<number>();

  const visit = (node: number): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const blocker of graph.get(node) || []) {
      if (visit(blocker)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };

  return visit(runId);
}

export class PathLockService {
  constructor(
    private readonly database: Database,
    private readonly distributedLock: DistributedLock,
  ) {}

  async acquire(input: {
    runId: number;
    repositoryKey: string;
    owner: string;
    paths: string[];
    ttlMs: number;
    waitUntil?: Date;
  }): Promise<PathLockAcquisition> {
    const paths = Array.from(new Set(input.paths.map(normalizeLockPath))).sort();
    if (!paths.length) throw new Error('At least one repository path is required for a path lock.');
    const repositoryKey = input.repositoryKey.trim();
    if (!repositoryKey) throw new Error('Repository key is required for a path lock.');
    const ttlMs = positiveTtl(input.ttlMs);

    return this.distributedLock.runExclusive(
      `agent-loop:path:${repositoryKey}`,
      () =>
        this.database.sequelize.transaction(async (transaction) => {
          const repository = this.database.getRepository('agentLoopPathLocks');
          const now = new Date();
          const existing = await repository.findOne({
            filter: { runId: input.runId, repositoryKey },
            transaction,
            lock: transaction.LOCK.UPDATE,
          });
          if (existing && read(existing, 'status') === 'held') {
            const sameOwner = String(read(existing, 'owner') || '') === input.owner;
            const samePaths = JSON.stringify(row(existing).paths.slice().sort()) === JSON.stringify(paths);
            if (sameOwner && samePaths && !lockIsExpired(existing, now)) {
              return { acquired: true, lock: row(existing), blockers: [] as number[] };
            }
          }

          const held = await repository.find({
            filter: { repositoryKey, status: 'held' },
            transaction,
            lock: transaction.LOCK.UPDATE,
          });
          const active: typeof held = [];
          for (const lock of held) {
            if (!lockIsExpired(lock, now)) {
              active.push(lock);
              continue;
            }
            await repository.update({
              filterByTk: read(lock, 'id'),
              values: { status: 'expired', releasedAt: now, blockerRunIds: [] },
              transaction,
            });
          }
          const blockers = active
            .map(row)
            .filter((lock) => lock.runId !== input.runId && pathSetsOverlap(paths, lock.paths))
            .map((lock) => lock.runId);

          if (blockers.length) {
            const waitingRows = (
              await repository.find({
                filter: { repositoryKey, status: 'waiting' },
                transaction,
                lock: transaction.LOCK.UPDATE,
              })
            ).map(row);
            if (waitGraphHasCycle(waitingRows, input.runId, blockers)) {
              return { acquired: false, deadlocked: true, blockers };
            }
            const values = {
              runId: input.runId,
              repositoryKey,
              owner: input.owner,
              paths,
              status: 'waiting',
              blockerRunIds: blockers,
              waitUntil: input.waitUntil || null,
              acquiredAt: null,
              expiresAt: null,
              releasedAt: null,
            };
            if (existing) {
              await repository.update({ filterByTk: read(existing, 'id'), values, transaction });
            } else {
              await repository.create({ values, transaction });
            }
            return { acquired: false, deadlocked: false, blockers };
          }

          const values = {
            runId: input.runId,
            repositoryKey,
            owner: input.owner,
            paths,
            status: 'held',
            blockerRunIds: [],
            acquiredAt: now,
            expiresAt: new Date(now.getTime() + ttlMs),
            waitUntil: null,
            releasedAt: null,
          };
          const locked = existing
            ? await this.updateAndRead(repository, Number(read(existing, 'id')), values, transaction)
            : await repository.create({ values, transaction });
          return { acquired: true, lock: row(locked), blockers: [] as number[] };
        }),
      Math.max(ttlMs, 5000),
    );
  }

  async renew(runId: number, repositoryKey: string, ttlMs: number, owner?: string) {
    const ttl = positiveTtl(ttlMs);
    return this.distributedLock.runExclusive(`agent-loop:path:${repositoryKey}`, async () => {
      const repository = this.database.getRepository('agentLoopPathLocks');
      // An expired lock is marked `expired` in its own committed transaction. Doing the audit
      // write inside the renew transaction and then throwing would roll the mark back, leaving a
      // stale `held` row that still reads as expired to the next acquirer but never audits it.
      const expired = await this.database.sequelize.transaction(async (transaction) => {
        const lock = await repository.findOne({
          filter: { runId, repositoryKey, status: 'held' },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!lock) throw new Error('Held path lock was not found.');
        if (owner !== undefined && String(read(lock, 'owner') || '') !== owner) {
          throw new Error('Path lock is no longer owned by this worker.');
        }
        const now = new Date();
        if (lockIsExpired(lock, now)) return { id: read(lock, 'id'), at: now };
        await repository.update({
          filterByTk: read(lock, 'id'),
          values: { expiresAt: new Date(now.getTime() + ttl) },
          transaction,
        });
        return null;
      });

      if (expired) {
        await this.database.sequelize.transaction(async (transaction) => {
          await repository.update({
            filterByTk: expired.id,
            values: { status: 'expired', releasedAt: expired.at, blockerRunIds: [] },
            transaction,
          });
        });
        throw new Error('Path lock has expired and must be reacquired.');
      }
    });
  }

  // The owner token guards against a reclaimed run: once a stale worker's lease expires and another
  // worker takes over the same run, the original worker must not free a lock the new owner now holds.
  async release(runId: number, repositoryKey: string, owner?: string) {
    return this.distributedLock.runExclusive(`agent-loop:path:${repositoryKey}`, async () => {
      const repository = this.database.getRepository('agentLoopPathLocks');
      const lock = await repository.findOne({ filter: { runId, repositoryKey } });
      if (!lock || ['released', 'expired'].includes(String(read(lock, 'status')))) return false;
      if (owner !== undefined && String(read(lock, 'owner') || '') !== owner) return false;
      await repository.update({
        filterByTk: read(lock, 'id'),
        values: { status: 'released', releasedAt: new Date(), blockerRunIds: [] },
      });
      return true;
    });
  }

  private async updateAndRead(
    repository: ReturnType<Database['getRepository']>,
    id: number,
    values: Record<string, unknown>,
    transaction: Transaction,
  ) {
    await repository.update({ filterByTk: id, values, transaction });
    const updated = await repository.findOne({ filterByTk: id, transaction });
    if (!updated) throw new Error('Path lock disappeared during update.');
    return updated;
  }
}
