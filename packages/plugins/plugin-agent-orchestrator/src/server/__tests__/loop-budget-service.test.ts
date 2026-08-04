import type { Database } from '@nocobase/database';
import { describe, expect, it } from 'vitest';
import { LoopBudgetService } from '../services/LoopBudgetService';
import { loopPatternPolicySchema } from '../services/LoopPatternSchema';

type Row = Record<string, unknown>;

function matches(row: Row, filter: Row) {
  return Object.entries(filter).every(([key, value]) => row[key] === value);
}

class MemoryRepository {
  private nextId = 1;

  constructor(readonly rows: Row[] = []) {
    this.resetSequence();
  }

  async find(options: Row = {}) {
    const filter = (options.filter as Row | undefined) || {};
    return this.rows.filter((row) => matches(row, filter));
  }

  async findOne(options: Row) {
    if (options.filterByTk !== undefined) return this.rows.find((row) => row.id === options.filterByTk) || null;
    return this.rows.find((row) => matches(row, (options.filter as Row | undefined) || {})) || null;
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

class SerialLock {
  readonly keys: string[] = [];
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(key: string, operation: () => Promise<T>) {
    this.keys.push(key);
    const previous = this.tails.get(key) || Promise.resolve();
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => pending);
    this.tails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

function run(id: number, patternId: number, values: Row = {}) {
  return {
    id,
    patternId,
    runtimeVersion: 'control-plane-v2',
    invocationCount: 0,
    toolCallCount: 0,
    delegationCount: 0,
    verificationCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    ...values,
  };
}

function createService(input: { runs?: Row[]; buckets?: Row[]; control?: Row } = {}) {
  const repositories = new Map<string, MemoryRepository>([
    ['agentLoopRuns', new MemoryRepository(input.runs || [run(1, 1)])],
    ['agentLoopUsageBuckets', new MemoryRepository(input.buckets || [])],
    [
      'agentLoopControlSettings',
      new MemoryRepository([
        {
          id: 1,
          key: 'global',
          state: 'running',
          dailyMaxTokens: null,
          dailyMaxCost: null,
          ...(input.control || {}),
        },
      ]),
    ],
  ]);
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const database = {
    getRepository(name: string) {
      const repository = repositories.get(name);
      if (!repository) throw new Error(`Unexpected repository ${name}`);
      return repository;
    },
    sequelize: {
      async transaction<T>(callback: (value: typeof transaction) => Promise<T>) {
        const before = new Map(
          Array.from(repositories, ([name, repository]) => [name, structuredClone(repository.rows)]),
        );
        try {
          return await callback(transaction);
        } catch (error) {
          for (const [name, rows] of before) repositories.get(name)?.restore(rows);
          throw error;
        }
      },
    },
  };
  const lock = new SerialLock();
  return {
    lock,
    repositories,
    service: new LoopBudgetService(database as unknown as Database, lock),
  };
}

function policy(input: Record<string, unknown> = {}) {
  return loopPatternPolicySchema.parse(input);
}

const now = new Date('2026-08-03T12:00:00.000Z');

describe('LoopBudgetService', () => {
  it('reserves run and daily usage atomically without undercounting token totals', async () => {
    const { lock, repositories, service } = createService();
    const result = await service.reserve({
      runId: 1,
      patternId: 1,
      policy: policy(),
      delta: { invocations: 1, toolCalls: 2, inputTokens: 30, outputTokens: 20, totalTokens: 10, cost: 0.25 },
      now,
    });

    expect(result).toMatchObject({
      bucketDate: '2026-08-03',
      reserved: { invocations: 1, toolCalls: 2, inputTokens: 30, outputTokens: 20, totalTokens: 50, cost: 0.25 },
    });
    expect(repositories.get('agentLoopRuns')?.rows[0]).toMatchObject({
      invocationCount: 1,
      toolCallCount: 2,
      totalInputTokens: 30,
      totalOutputTokens: 20,
      totalTokens: 50,
      totalCost: 0.25,
    });
    expect(repositories.get('agentLoopUsageBuckets')?.rows[0]).toMatchObject({
      patternId: 1,
      bucketDate: '2026-08-03',
      invocationCount: 1,
      toolCallCount: 2,
      totalTokens: 50,
      totalCost: 0.25,
    });
    expect(lock.keys).toEqual(['agent-loop:budget:global:2026-08-03']);
  });

  it('rolls back both rows when a per-run or pattern-daily limit rejects the reservation', async () => {
    const { repositories, service } = createService({
      runs: [run(1, 1, { invocationCount: 1, totalTokens: 5 })],
      buckets: [{ id: 1, patternId: 1, bucketDate: '2026-08-03', invocationCount: 1, totalTokens: 5 }],
    });
    const runPolicy = policy({ perRun: { maxInvocations: 1 } });
    await expect(
      service.reserve({ runId: 1, patternId: 1, policy: runPolicy, delta: { invocations: 1 }, now }),
    ).rejects.toThrow('Per-run invocation budget exceeded');

    const dailyPolicy = policy({ daily: { maxTokens: 5 } });
    await expect(
      service.reserve({ runId: 1, patternId: 1, policy: dailyPolicy, delta: { totalTokens: 1 }, now }),
    ).rejects.toThrow('Daily token budget exceeded');

    expect(repositories.get('agentLoopRuns')?.rows[0]).toMatchObject({ invocationCount: 1, totalTokens: 5 });
    expect(repositories.get('agentLoopUsageBuckets')?.rows[0]).toMatchObject({ invocationCount: 1, totalTokens: 5 });
  });

  it('enforces global daily caps across different patterns', async () => {
    const { repositories, service } = createService({
      runs: [run(1, 1), run(2, 2)],
      buckets: [
        { id: 1, patternId: 1, bucketDate: '2026-08-03', totalTokens: 60, totalCost: 1 },
        { id: 2, patternId: 2, bucketDate: '2026-08-03', totalTokens: 30, totalCost: 1 },
      ],
      control: { dailyMaxTokens: 100, dailyMaxCost: 2.5 },
    });

    await expect(
      service.reserve({ runId: 2, patternId: 2, policy: policy(), delta: { totalTokens: 11 }, now }),
    ).rejects.toThrow('Global daily token budget exceeded');
    await expect(
      service.reserve({ runId: 2, patternId: 2, policy: policy(), delta: { cost: 0.6 }, now }),
    ).rejects.toThrow('Global daily cost budget exceeded');

    expect(repositories.get('agentLoopRuns')?.rows[1]).toMatchObject({ totalTokens: 0, totalCost: 0 });
    expect(repositories.get('agentLoopUsageBuckets')?.rows[1]).toMatchObject({ totalTokens: 30, totalCost: 1 });
  });

  it('serializes racing reservations so only one can cross the remaining budget boundary', async () => {
    const { repositories, service } = createService();
    const limited = policy({ perRun: { maxTokens: 10 }, daily: { maxTokens: 10 } });
    const requests = await Promise.allSettled([
      service.reserve({ runId: 1, patternId: 1, policy: limited, delta: { totalTokens: 6 }, now }),
      service.reserve({ runId: 1, patternId: 1, policy: limited, delta: { totalTokens: 6 }, now }),
    ]);

    expect(requests.filter((request) => request.status === 'fulfilled')).toHaveLength(1);
    expect(requests.filter((request) => request.status === 'rejected')).toHaveLength(1);
    expect(repositories.get('agentLoopRuns')?.rows[0].totalTokens).toBe(6);
    expect(repositories.get('agentLoopUsageBuckets')?.rows[0].totalTokens).toBe(6);
  });

  it('fails closed for invalid deltas, historical runs, mismatched patterns, and paused control', async () => {
    const invalid = createService();
    await expect(
      invalid.service.reserve({ runId: 1, patternId: 1, policy: policy(), delta: { toolCalls: 0.5 }, now }),
    ).rejects.toThrow('nonnegative integer');
    expect(invalid.repositories.get('agentLoopUsageBuckets')?.rows).toHaveLength(0);

    const historical = createService({ runs: [run(1, 1, { runtimeVersion: 'legacy-plan-v1' })] });
    await expect(
      historical.service.reserve({ runId: 1, patternId: 1, policy: policy(), delta: { invocations: 1 }, now }),
    ).rejects.toThrow('Historical plan-era');

    const mismatched = createService();
    await expect(
      mismatched.service.reserve({ runId: 1, patternId: 2, policy: policy(), delta: { invocations: 1 }, now }),
    ).rejects.toThrow('does not belong to pattern');

    const paused = createService({ control: { state: 'paused', reason: 'Maintenance' } });
    await expect(
      paused.service.reserve({ runId: 1, patternId: 1, policy: policy(), delta: { invocations: 1 }, now }),
    ).rejects.toThrow('Maintenance');
  });
});
