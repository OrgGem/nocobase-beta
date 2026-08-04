import { createHash } from 'node:crypto';
import type { Database, Model } from '@nocobase/database';
import type { LoopPatternPolicy } from './LoopPatternSchema';

type DistributedLock = {
  runExclusive<T>(key: string, operation: () => Promise<T>, ttl?: number): Promise<T>;
};

type CircuitSnapshot = {
  id: number;
  state: 'closed' | 'open' | 'half_open';
  attempts: number;
  consecutiveFailures: number;
  errorSignature: string;
  repeatedErrorCount: number;
  retryAt: Date | null;
};

function read(record: Model | Record<string, unknown>, key: string) {
  const model = record as Model & { get?: (name: string) => unknown };
  return typeof model.get === 'function' ? model.get(key) : (record as Record<string, unknown>)[key];
}

function count(value: unknown, label: string) {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} counter is invalid.`);
  return parsed;
}

function dateOrNull(value: unknown) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function snapshot(record: Model | Record<string, unknown>): CircuitSnapshot {
  const id = Number(read(record, 'id'));
  const state = read(record, 'state');
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Circuit breaker state has an invalid identifier.');
  if (state !== 'closed' && state !== 'open' && state !== 'half_open') {
    throw new Error('Circuit breaker state is invalid.');
  }
  return {
    id,
    state,
    attempts: count(read(record, 'attempts'), 'Circuit attempt'),
    consecutiveFailures: count(read(record, 'consecutiveFailures'), 'Circuit consecutive failure'),
    errorSignature: typeof read(record, 'errorSignature') === 'string' ? String(read(record, 'errorSignature')) : '',
    repeatedErrorCount: count(read(record, 'repeatedErrorCount'), 'Circuit repeated error'),
    retryAt: dateOrNull(read(record, 'retryAt')),
  };
}

function normalizeScopeKey(scopeKey: string) {
  const normalized = scopeKey.trim();
  if (!normalized) throw new Error('Circuit breaker scope key is required.');
  if (normalized.length > 300) throw new Error('Circuit breaker scope key cannot exceed 300 characters.');
  return normalized;
}

export function normalizeErrorSignature(error: unknown) {
  const raw = error instanceof Error ? `${error.name}:${error.message}` : String(error);
  const normalized = raw
    .toLowerCase()
    .replace(/[a-z]:[\\/][^\s"']+/gi, '<path>')
    .replace(/\/(?:[^\s/]+\/)+[^\s"']*/g, '<path>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<uuid>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256')
    .update(normalized || 'unknown-error')
    .digest('hex');
}

export class DurableCircuitBreakerService {
  constructor(
    private readonly database: Database,
    private readonly distributedLock: DistributedLock,
  ) {}

  async authorizeAttempt(input: {
    patternId: number;
    scopeKey: string;
    policy: LoopPatternPolicy['circuit'];
    now?: Date;
  }) {
    const scopeKey = normalizeScopeKey(input.scopeKey);
    const now = input.now || new Date();
    return this.withScopeLock(input.patternId, scopeKey, async () => {
      const decision = await this.database.sequelize.transaction(async (transaction) => {
        const repository = this.database.getRepository('agentLoopCircuitStates');
        let record = await repository.findOne({
          filter: { patternId: input.patternId, scopeKey },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!record) {
          record = await repository.create({
            values: {
              patternId: input.patternId,
              scopeKey,
              state: 'closed',
              attempts: 0,
              consecutiveFailures: 0,
              repeatedErrorCount: 0,
            },
            transaction,
          });
        }
        const current = snapshot(record);
        if (current.state === 'half_open') {
          return { allowed: false as const, reason: 'probe' as const, retryAt: current.retryAt };
        }
        if (current.state === 'open' && (!current.retryAt || current.retryAt.getTime() > now.getTime())) {
          return { allowed: false as const, reason: 'open' as const, retryAt: current.retryAt };
        }
        if (current.state === 'closed' && current.attempts >= input.policy.maxAttempts) {
          const retryAt = new Date(now.getTime() + input.policy.cooldownMs);
          await repository.update({
            filterByTk: current.id,
            values: { state: 'open', openedAt: now, retryAt },
            transaction,
          });
          return { allowed: false as const, reason: 'attempts' as const, retryAt };
        }
        const nextState = current.state === 'open' ? 'half_open' : 'closed';
        await repository.update({
          filterByTk: current.id,
          values: { state: nextState, attempts: current.attempts + 1 },
          transaction,
        });
        return { allowed: true as const, state: nextState, attempt: current.attempts + 1 };
      });
      if (decision.allowed) return decision;
      if (decision.reason === 'probe') throw new Error('Circuit breaker probe is already in progress.');
      if (decision.reason === 'attempts') throw new Error('Circuit breaker maximum attempts reached.');
      throw new Error(`Circuit breaker is open until ${decision.retryAt?.toISOString() || 'manual reset'}.`);
    });
  }

  async recordSuccess(patternId: number, scopeKey: string, lastRunId?: number) {
    const normalizedScope = normalizeScopeKey(scopeKey);
    return this.withScopeLock(patternId, normalizedScope, async () =>
      this.database.sequelize.transaction(async (transaction) => {
        const repository = this.database.getRepository('agentLoopCircuitStates');
        const record = await repository.findOne({
          filter: { patternId, scopeKey: normalizedScope },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!record) return;
        await repository.update({
          filterByTk: read(record, 'id'),
          values: {
            state: 'closed',
            attempts: 0,
            consecutiveFailures: 0,
            errorSignature: null,
            repeatedErrorCount: 0,
            lastRunId: lastRunId || null,
            openedAt: null,
            retryAt: null,
          },
          transaction,
        });
      }),
    );
  }

  async recordFailure(input: {
    patternId: number;
    scopeKey: string;
    policy: LoopPatternPolicy['circuit'];
    error: unknown;
    lastRunId?: number;
    now?: Date;
  }) {
    const scopeKey = normalizeScopeKey(input.scopeKey);
    const signature = normalizeErrorSignature(input.error);
    const now = input.now || new Date();
    return this.withScopeLock(input.patternId, scopeKey, async () =>
      this.database.sequelize.transaction(async (transaction) => {
        const repository = this.database.getRepository('agentLoopCircuitStates');
        let record = await repository.findOne({
          filter: { patternId: input.patternId, scopeKey },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!record) {
          record = await repository.create({
            values: {
              patternId: input.patternId,
              scopeKey,
              state: 'closed',
              attempts: 1,
              consecutiveFailures: 0,
              repeatedErrorCount: 0,
            },
            transaction,
          });
        }
        const current = snapshot(record);
        const consecutiveFailures = current.consecutiveFailures + 1;
        const repeatedErrorCount = current.errorSignature === signature ? current.repeatedErrorCount + 1 : 1;
        const shouldOpen =
          current.state === 'half_open' ||
          current.attempts >= input.policy.maxAttempts ||
          consecutiveFailures >= input.policy.maxConsecutiveFailures ||
          repeatedErrorCount >= input.policy.maxRepeatedError;
        await repository.update({
          filterByTk: current.id,
          values: {
            state: shouldOpen ? 'open' : 'closed',
            consecutiveFailures,
            errorSignature: signature,
            repeatedErrorCount,
            lastRunId: input.lastRunId || null,
            openedAt: shouldOpen ? now : null,
            retryAt: shouldOpen ? new Date(now.getTime() + input.policy.cooldownMs) : null,
          },
          transaction,
        });
        return { open: shouldOpen, signature, consecutiveFailures, repeatedErrorCount };
      }),
    );
  }

  private withScopeLock<T>(patternId: number, scopeKey: string, operation: () => Promise<T>) {
    const normalizedScope = scopeKey.trim();
    if (!normalizedScope) throw new Error('Circuit breaker scope key is required.');
    return this.distributedLock.runExclusive(
      `agent-loop:circuit:${patternId}:${createHash('sha256').update(normalizedScope).digest('hex')}`,
      operation,
      30_000,
    );
  }
}
