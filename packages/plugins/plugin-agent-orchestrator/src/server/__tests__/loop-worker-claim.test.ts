import type { Database } from '@nocobase/database';
import { describe, expect, it } from 'vitest';
import { loopPatternPolicySchema } from '../services/LoopPatternSchema';
import { LoopRunStateMachine } from '../services/LoopRunStateMachine';

type Row = Record<string, unknown>;

function matchesValue(actual: unknown, expected: unknown) {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    const operators = expected as Record<string, unknown>;
    if (Array.isArray(operators.$in)) return operators.$in.includes(actual);
  }
  return actual === expected;
}

function matches(row: Row, filter: Row) {
  return Object.entries(filter).every(([key, value]) => matchesValue(row[key], value));
}

class MemoryRepository {
  private nextId = 1;

  constructor(readonly rows: Row[] = []) {
    this.resetSequence();
  }

  async find(options: Row = {}) {
    const filter = (options.filter as Row | undefined) || {};
    const rows = this.rows.filter((row) => matches(row, filter));
    const sort = (options.sort as string[] | undefined) || [];
    rows.sort((left, right) => {
      for (const field of sort) {
        const descending = field.startsWith('-');
        const key = descending ? field.slice(1) : field;
        const leftValue = left[key];
        const rightValue = right[key];
        if (leftValue === rightValue) continue;
        const result = String(leftValue) < String(rightValue) ? -1 : 1;
        return descending ? -result : result;
      }
      return 0;
    });
    return rows.slice(0, Number(options.limit) || rows.length);
  }

  async findOne(options: Row) {
    if (options.filterByTk !== undefined) return this.rows.find((row) => row.id === options.filterByTk) || null;
    return (await this.find(options))[0] || null;
  }

  async count(options: Row = {}) {
    return (await this.find(options)).length;
  }

  async create(options: Row) {
    const row = { id: this.nextId++, ...((options.values as Row | undefined) || {}) };
    this.rows.push(row);
    return row;
  }

  async update(options: Row) {
    const values = (options.values as Row | undefined) || {};
    for (const row of this.rows) {
      if (options.filterByTk !== undefined && row.id === options.filterByTk) Object.assign(row, values);
    }
  }

  restore(rows: Row[]) {
    this.rows.splice(0, this.rows.length, ...structuredClone(rows));
    this.resetSequence();
  }

  private resetSequence() {
    this.nextId = this.rows.reduce((maximum, row) => Math.max(maximum, Number(row.id) || 0), 0) + 1;
  }
}

class TransactionQueue {
  private tail = Promise.resolve();

  async run<T>(operation: () => Promise<T>) {
    let release = () => {};
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function run(id: number, patternId: number, status: string, values: Row = {}) {
  return {
    id,
    rootRunId: `loop-${id}`,
    runtimeVersion: 'control-plane-v2',
    patternId,
    status,
    policySnapshot: loopPatternPolicySchema.parse({ maxConcurrency: 1 }),
    createdAt: new Date(`2026-08-03T00:00:${String(id).padStart(2, '0')}.000Z`),
    lockedBy: null,
    lockedUntil: null,
    ...values,
  };
}

function createStateMachine(input: { runs: Row[]; patterns?: Row[]; globalMaxConcurrency?: number }) {
  const repositories = new Map<string, MemoryRepository>([
    ['agentLoopRuns', new MemoryRepository(input.runs)],
    [
      'agentLoopPatterns',
      new MemoryRepository(
        input.patterns || [
          { id: 1, enabled: true },
          { id: 2, enabled: true },
          { id: 3, enabled: true },
        ],
      ),
    ],
    ['agentLoopEvents', new MemoryRepository()],
    [
      'agentLoopControlSettings',
      new MemoryRepository([
        {
          id: 1,
          key: 'global',
          state: 'running',
          acceptNewRuns: true,
          globalMaxConcurrency: input.globalMaxConcurrency || 5,
          dailyMaxTokens: null,
          dailyMaxCost: null,
        },
      ]),
    ],
  ]);
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const queue = new TransactionQueue();
  const database = {
    getRepository(name: string) {
      const repository = repositories.get(name);
      if (!repository) throw new Error(`Unexpected repository ${name}`);
      return repository;
    },
    sequelize: {
      transaction<T>(callback: (value: typeof transaction) => Promise<T>) {
        return queue.run(async () => {
          const before = new Map(
            Array.from(repositories, ([name, repository]) => [name, structuredClone(repository.rows)]),
          );
          try {
            return await callback(transaction);
          } catch (error) {
            for (const [name, rows] of before) repositories.get(name)?.restore(rows);
            throw error;
          }
        });
      },
    },
  };
  return {
    repositories,
    stateMachine: new LoopRunStateMachine(database as unknown as Database),
  };
}

describe('LoopRunStateMachine worker leases', () => {
  it('allows only one of two workers to claim a queued run', async () => {
    const { repositories, stateMachine } = createStateMachine({ runs: [run(1, 1, 'queued')] });
    const claims = await Promise.all([
      stateMachine.claimNext('worker-a', 30_000),
      stateMachine.claimNext('worker-b', 30_000),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(repositories.get('agentLoopRuns')?.rows[0]).toMatchObject({ status: 'preparing' });
    expect(String(repositories.get('agentLoopRuns')?.rows[0].lockedBy)).toMatch(/^worker-[ab]:/);
    expect(repositories.get('agentLoopEvents')?.rows).toHaveLength(1);
    expect(repositories.get('agentLoopEvents')?.rows[0]).toMatchObject({ type: 'run_claimed', status: 'preparing' });
  });

  it('blocks malformed snapshots and skips a pattern at capacity without hiding another pattern', async () => {
    const { repositories, stateMachine } = createStateMachine({
      runs: [
        run(1, 3, 'queued', { policySnapshot: { maxConcurrency: 0 } }),
        run(2, 1, 'running'),
        run(3, 1, 'queued'),
        run(4, 2, 'queued'),
      ],
    });

    const claimed = await stateMachine.claimNext('worker-a', 30_000);

    expect(claimed?.run.id).toBe(4);
    expect(repositories.get('agentLoopRuns')?.rows[0]).toMatchObject({
      status: 'blocked',
      blockedReason: 'Run policy snapshot is invalid.',
    });
    expect(repositories.get('agentLoopRuns')?.rows[2].status).toBe('queued');
    expect(repositories.get('agentLoopRuns')?.rows[3].status).toBe('preparing');
    expect(repositories.get('agentLoopEvents')?.rows).toMatchObject([
      { runId: 1, type: 'run_blocked' },
      { runId: 4, type: 'run_claimed' },
    ]);
  });

  it('enforces global concurrency before claiming another run', async () => {
    const { repositories, stateMachine } = createStateMachine({
      runs: [run(1, 1, 'running'), run(2, 2, 'queued')],
      globalMaxConcurrency: 1,
    });

    await expect(stateMachine.claimNext('worker-a', 30_000)).resolves.toBeNull();
    expect(repositories.get('agentLoopRuns')?.rows[1].status).toBe('queued');
    expect(repositories.get('agentLoopEvents')?.rows).toHaveLength(0);
  });

  it('rejects stale worker transitions and accepts the current unexpired lease', async () => {
    const { repositories, stateMachine } = createStateMachine({ runs: [run(1, 1, 'queued')] });
    const claimed = await stateMachine.claimNext('worker-a', 30_000);
    if (!claimed) throw new Error('Expected the queued run to be claimed.');

    const transition = {
      runId: 1,
      to: 'running' as const,
      actorType: 'worker',
      actorIdentity: 'worker-a',
    };
    await expect(stateMachine.transition(transition)).rejects.toThrow('no longer owned');
    await expect(stateMachine.transition({ ...transition, leaseToken: 'worker-b:wrong' })).rejects.toThrow(
      'no longer owned',
    );

    const expiredRunRow = repositories.get('agentLoopRuns')?.rows[0];
    if (!expiredRunRow) throw new Error('Expected claimed run.');
    expiredRunRow.lockedUntil = new Date(Date.now() - 1_000);
    await expect(stateMachine.transition({ ...transition, leaseToken: claimed.leaseToken })).rejects.toThrow('expired');

    const currentRunRow = repositories.get('agentLoopRuns')?.rows[0];
    if (!currentRunRow) throw new Error('Expected claimed run after rollback.');
    currentRunRow.lockedUntil = new Date(Date.now() + 30_000);
    await expect(stateMachine.transition({ ...transition, leaseToken: claimed.leaseToken })).resolves.toMatchObject({
      from: 'preparing',
      to: 'running',
    });
    expect(currentRunRow.status).toBe('running');
    expect(repositories.get('agentLoopEvents')?.rows).toMatchObject([
      { type: 'run_claimed', status: 'preparing' },
      { type: 'run_status_changed', status: 'running' },
    ]);
  });

  it('renews and releases only the matching worker lease', async () => {
    const { repositories, stateMachine } = createStateMachine({ runs: [run(1, 1, 'queued')] });
    const claimed = await stateMachine.claimNext('worker-a', 30_000);
    if (!claimed) throw new Error('Expected the queued run to be claimed.');

    await expect(stateMachine.renewLease(1, 'worker-b:wrong', 30_000)).rejects.toThrow('no longer owned');
    const renewedUntil = await stateMachine.renewLease(1, claimed.leaseToken, 30_000);
    expect(renewedUntil.getTime()).toBeGreaterThan(Date.now());
    await expect(stateMachine.releaseLease(1, 'worker-b:wrong')).rejects.toThrow('no longer owned');
    await expect(stateMachine.releaseLease(1, claimed.leaseToken)).resolves.toBe(true);
    expect(repositories.get('agentLoopRuns')?.rows[0]).toMatchObject({ lockedBy: null, lockedUntil: null });
  });

  it('reclaims a crashed run with an expired lease and frees its concurrency slot', async () => {
    const { repositories, stateMachine } = createStateMachine({
      runs: [
        run(1, 1, 'running', { lockedBy: 'worker-dead:1', lockedUntil: new Date(Date.now() - 1_000) }),
        run(2, 2, 'queued'),
      ],
      globalMaxConcurrency: 1,
    });

    const claimed = await stateMachine.claimNext('worker-a', 30_000);

    // Without reclaim the crashed run would hold the single global slot forever and nothing
    // could be claimed. Once requeued it is the oldest candidate, so it is picked up first.
    expect(claimed?.run.id).toBe(1);
    expect(String(claimed?.leaseToken)).toMatch(/^worker-a:/);
    expect(repositories.get('agentLoopRuns')?.rows[0]).toMatchObject({ status: 'preparing' });
    expect(repositories.get('agentLoopRuns')?.rows[1].status).toBe('queued');
    expect(repositories.get('agentLoopEvents')?.rows).toMatchObject([
      { runId: 1, type: 'run_lease_expired', status: 'queued' },
      { runId: 1, type: 'run_claimed', status: 'preparing' },
    ]);
  });

  it('does not reclaim an active run that has no lease owner yet', async () => {
    const { repositories, stateMachine } = createStateMachine({
      runs: [run(1, 1, 'running', { lockedBy: null, lockedUntil: null }), run(2, 2, 'queued')],
      globalMaxConcurrency: 1,
    });

    // An owner-less active run still occupies its slot; requeueing it would double-dispatch work.
    await expect(stateMachine.claimNext('worker-a', 30_000)).resolves.toBeNull();
    expect(repositories.get('agentLoopRuns')?.rows[0].status).toBe('running');
    expect(repositories.get('agentLoopRuns')?.rows[1].status).toBe('queued');
    expect(repositories.get('agentLoopEvents')?.rows).toHaveLength(0);
  });

  it('stops a worker from carrying a paused or canceled run forward', async () => {
    const { repositories, stateMachine } = createStateMachine({ runs: [run(1, 1, 'queued')] });
    const claimed = await stateMachine.claimNext('worker-a', 30_000);
    if (!claimed) throw new Error('Expected the queued run to be claimed.');
    await stateMachine.transition({
      runId: 1,
      to: 'running',
      actorType: 'worker',
      actorIdentity: 'worker-a',
      leaseToken: claimed.leaseToken,
    });

    // A human pause leaves the worker lease in place, so the lease check alone would let the
    // in-flight worker continue. `paused -> verifying` is a legal edge for a human resume, and
    // without the actor guard the worker would walk straight through the pause.
    const runRow = repositories.get('agentLoopRuns')?.rows[0];
    if (!runRow) throw new Error('Expected the claimed run.');
    await stateMachine.transition({ runId: 1, to: 'paused', actorType: 'human', actorIdentity: '1' });
    expect(runRow.status).toBe('paused');

    await expect(
      stateMachine.transition({
        runId: 1,
        to: 'verifying',
        actorType: 'worker',
        actorIdentity: 'worker-a',
        leaseToken: claimed.leaseToken,
      }),
    ).rejects.toThrow('A worker cannot transition a run that is paused.');
    expect(runRow.status).toBe('paused');

    // The human resume path is unaffected.
    await expect(
      stateMachine.transition({ runId: 1, to: 'queued', actorType: 'human', actorIdentity: '1' }),
    ).resolves.toMatchObject({ from: 'paused', to: 'queued' });
  });
});
