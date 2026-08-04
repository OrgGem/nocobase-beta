import type { Database } from '@nocobase/database';
import { describe, expect, it } from 'vitest';
import { DurableCircuitBreakerService, normalizeErrorSignature } from '../services/DurableCircuitBreakerService';
import { loopPatternPolicySchema } from '../services/LoopPatternSchema';

type Row = Record<string, unknown>;

function matches(row: Row, filter: Row) {
  return Object.entries(filter).every(([key, value]) => row[key] === value);
}

class MemoryRepository {
  private nextId = 1;

  constructor(readonly rows: Row[] = []) {
    this.nextId = rows.reduce((maximum, row) => Math.max(maximum, Number(row.id) || 0), 0) + 1;
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
    this.nextId = this.rows.reduce((maximum, row) => Math.max(maximum, Number(row.id) || 0), 0) + 1;
  }
}

class SerialLock {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(key: string, operation: () => Promise<T>) {
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

function createService(initialRows: Row[] = []) {
  const circuits = new MemoryRepository(initialRows);
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const database = {
    getRepository(name: string) {
      if (name !== 'agentLoopCircuitStates') throw new Error(`Unexpected repository ${name}`);
      return circuits;
    },
    sequelize: {
      async transaction<T>(callback: (value: typeof transaction) => Promise<T>) {
        const before = structuredClone(circuits.rows);
        try {
          return await callback(transaction);
        } catch (error) {
          circuits.restore(before);
          throw error;
        }
      },
    },
  };
  return {
    circuits,
    service: new DurableCircuitBreakerService(database as unknown as Database, new SerialLock()),
  };
}

function circuitPolicy(overrides: Record<string, number> = {}) {
  return loopPatternPolicySchema.parse({ circuit: overrides }).circuit;
}

describe('DurableCircuitBreakerService', () => {
  it('normalizes volatile paths, identifiers, and numbers into one error signature', () => {
    const first = new Error('Failed C:\\repo\\one\\file.ts for 123e4567-e89b-12d3-a456-426614174000 at line 42');
    const second = new Error('Failed C:\\repo\\two\\file.ts for 223e4567-e89b-12d3-a456-426614174999 at line 99');
    expect(normalizeErrorSignature(first)).toBe(normalizeErrorSignature(second));
    expect(normalizeErrorSignature(new Error('Permission denied'))).not.toBe(normalizeErrorSignature(first));
  });

  it('canonicalizes the scope and durably opens after the maximum attempt count', async () => {
    const { circuits, service } = createService();
    const policy = circuitPolicy({
      maxAttempts: 2,
      maxConsecutiveFailures: 99,
      maxRepeatedError: 99,
      cooldownMs: 1_000,
    });
    const now = new Date('2026-08-03T00:00:00.000Z');

    await expect(service.authorizeAttempt({ patternId: 1, scopeKey: ' repo ', policy, now })).resolves.toMatchObject({
      state: 'closed',
      attempt: 1,
    });
    await service.authorizeAttempt({ patternId: 1, scopeKey: 'repo', policy, now });
    await expect(service.authorizeAttempt({ patternId: 1, scopeKey: 'repo', policy, now })).rejects.toThrow(
      'maximum attempts',
    );

    expect(circuits.rows).toHaveLength(1);
    expect(circuits.rows[0]).toMatchObject({ scopeKey: 'repo', state: 'open', attempts: 2 });
    expect(circuits.rows[0].retryAt).toEqual(new Date('2026-08-03T00:00:01.000Z'));
  });

  it('opens on repeated normalized errors and consecutive different failures', async () => {
    const repeated = createService();
    const repeatedPolicy = circuitPolicy({
      maxAttempts: 99,
      maxConsecutiveFailures: 99,
      maxRepeatedError: 2,
      cooldownMs: 1_000,
    });
    await repeated.service.authorizeAttempt({ patternId: 1, scopeKey: 'repo', policy: repeatedPolicy });
    await repeated.service.recordFailure({
      patternId: 1,
      scopeKey: 'repo',
      policy: repeatedPolicy,
      error: new Error('Failed C:\\repo\\one\\file.ts at line 42'),
    });
    await repeated.service.authorizeAttempt({ patternId: 1, scopeKey: 'repo', policy: repeatedPolicy });
    const repeatedResult = await repeated.service.recordFailure({
      patternId: 1,
      scopeKey: 'repo',
      policy: repeatedPolicy,
      error: new Error('Failed C:\\repo\\two\\file.ts at line 99'),
    });
    expect(repeatedResult).toMatchObject({ open: true, repeatedErrorCount: 2 });

    const consecutive = createService();
    const consecutivePolicy = circuitPolicy({
      maxAttempts: 99,
      maxConsecutiveFailures: 2,
      maxRepeatedError: 99,
      cooldownMs: 1_000,
    });
    await consecutive.service.authorizeAttempt({ patternId: 1, scopeKey: 'repo', policy: consecutivePolicy });
    await consecutive.service.recordFailure({
      patternId: 1,
      scopeKey: 'repo',
      policy: consecutivePolicy,
      error: new Error('First failure'),
    });
    await consecutive.service.authorizeAttempt({ patternId: 1, scopeKey: 'repo', policy: consecutivePolicy });
    const consecutiveResult = await consecutive.service.recordFailure({
      patternId: 1,
      scopeKey: 'repo',
      policy: consecutivePolicy,
      error: new Error('Different failure'),
    });
    expect(consecutiveResult).toMatchObject({ open: true, consecutiveFailures: 2, repeatedErrorCount: 1 });
  });

  it('rejects before cooldown and allows exactly one half-open probe', async () => {
    const retryAt = new Date('2026-08-03T00:00:10.000Z');
    const { circuits, service } = createService([
      {
        id: 1,
        patternId: 1,
        scopeKey: 'repo',
        state: 'open',
        attempts: 1,
        consecutiveFailures: 1,
        errorSignature: 'signature',
        repeatedErrorCount: 1,
        retryAt,
      },
    ]);
    const policy = circuitPolicy({ maxAttempts: 99, maxConsecutiveFailures: 99, maxRepeatedError: 99 });

    await expect(
      service.authorizeAttempt({ patternId: 1, scopeKey: 'repo', policy, now: new Date('2026-08-03T00:00:09.000Z') }),
    ).rejects.toThrow('open until');

    const results = await Promise.allSettled([
      service.authorizeAttempt({ patternId: 1, scopeKey: 'repo', policy, now: retryAt }),
      service.authorizeAttempt({ patternId: 1, scopeKey: 'repo', policy, now: retryAt }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(circuits.rows[0]).toMatchObject({ state: 'half_open', attempts: 2 });
  });

  it('reopens a failed probe and resets all state after success', async () => {
    const retryAt = new Date('2026-08-03T00:00:00.000Z');
    const { circuits, service } = createService([
      {
        id: 1,
        patternId: 1,
        scopeKey: 'repo',
        state: 'open',
        attempts: 1,
        consecutiveFailures: 1,
        errorSignature: 'old',
        repeatedErrorCount: 1,
        retryAt,
      },
    ]);
    const policy = circuitPolicy({
      maxAttempts: 99,
      maxConsecutiveFailures: 99,
      maxRepeatedError: 99,
      cooldownMs: 1_000,
    });

    await service.authorizeAttempt({ patternId: 1, scopeKey: 'repo', policy, now: retryAt });
    const failure = await service.recordFailure({
      patternId: 1,
      scopeKey: 'repo',
      policy,
      error: new Error('Probe failed'),
      now: retryAt,
    });
    expect(failure.open).toBe(true);
    expect(circuits.rows[0].state).toBe('open');

    await service.recordSuccess(1, ' repo ', 9);
    expect(circuits.rows[0]).toMatchObject({
      state: 'closed',
      attempts: 0,
      consecutiveFailures: 0,
      errorSignature: null,
      repeatedErrorCount: 0,
      lastRunId: 9,
      retryAt: null,
    });
  });
});
