import type { Database, Model } from '@nocobase/database';
import type { LoopPatternPolicy } from './LoopPatternSchema';
import { read } from '../utils/record-utils';

export type UsageDelta = {
  invocations?: number;
  toolCalls?: number;
  delegations?: number;
  verifications?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cost?: number;
};

type UsageTotals = Required<UsageDelta>;

function storedCount(value: unknown, label: string) {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} counter is invalid.`);
  return parsed;
}

function storedCost(value: unknown, label: string) {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} counter is invalid.`);
  return parsed;
}

function deltaCount(value: unknown, label: string) {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error(`${label} usage delta must be a nonnegative integer.`);
  return parsed;
}

function deltaCost(value: unknown) {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('Cost usage delta must be a nonnegative finite number.');
  return parsed;
}

function normalizedDelta(delta: UsageDelta): UsageTotals {
  const result = {
    invocations: deltaCount(delta.invocations, 'Invocation'),
    toolCalls: deltaCount(delta.toolCalls, 'Tool call'),
    delegations: deltaCount(delta.delegations, 'Delegation'),
    verifications: deltaCount(delta.verifications, 'Verification'),
    inputTokens: deltaCount(delta.inputTokens, 'Input token'),
    outputTokens: deltaCount(delta.outputTokens, 'Output token'),
    totalTokens: deltaCount(delta.totalTokens, 'Total token'),
    cost: deltaCost(delta.cost),
  };
  result.totalTokens = Math.max(result.totalTokens, result.inputTokens + result.outputTokens);
  return result;
}

function storedLimit(value: unknown, label: string) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} limit is invalid.`);
  return parsed;
}

function exceeds(current: number, delta: number, limit: number | null, label: string) {
  if (limit !== null && current + delta > limit) {
    throw new Error(`${label} budget exceeded: ${current} + ${delta} > ${limit}.`);
  }
}

function bucketDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

type DistributedLock = {
  runExclusive<T>(key: string, operation: () => Promise<T>, ttl?: number): Promise<T>;
};

export class LoopBudgetService {
  constructor(
    private readonly database: Database,
    private readonly distributedLock: DistributedLock,
  ) {}

  async reserve(input: { runId: number; patternId: number; policy: LoopPatternPolicy; delta: UsageDelta; now?: Date }) {
    if (!Number.isSafeInteger(input.runId) || input.runId <= 0) throw new Error('A valid run identifier is required.');
    if (!Number.isSafeInteger(input.patternId) || input.patternId <= 0)
      throw new Error('A valid pattern identifier is required.');
    const delta = normalizedDelta(input.delta);
    const date = bucketDate(input.now || new Date());
    return this.distributedLock.runExclusive(
      `agent-loop:budget:global:${date}`,
      () => this.reserveInTransaction(input, delta, date),
      30_000,
    );
  }

  private async reserveInTransaction(
    input: { runId: number; patternId: number; policy: LoopPatternPolicy; delta: UsageDelta },
    delta: UsageTotals,
    date: string,
  ) {
    return this.database.sequelize.transaction(async (transaction) => {
      const controls = this.database.getRepository('agentLoopControlSettings');
      const control = await controls.findOne({
        filter: { key: 'global' },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!control) throw new Error('Global Loop Control settings were not found.');
      if (String(read(control, 'state')) !== 'running') {
        throw new Error(String(read(control, 'reason') || 'Loop Control Plane is not running.'));
      }

      const runs = this.database.getRepository('agentLoopRuns');
      const run = await runs.findOne({
        filterByTk: input.runId,
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!run) throw new Error(`Agent loop run ${input.runId} was not found.`);
      if (String(read(run, 'runtimeVersion')) !== 'control-plane-v2') {
        throw new Error('Historical plan-era runs cannot consume Loop Control Plane budgets.');
      }
      if (Number(read(run, 'patternId')) !== input.patternId) {
        throw new Error(`Agent loop run ${input.runId} does not belong to pattern ${input.patternId}.`);
      }

      const buckets = this.database.getRepository('agentLoopUsageBuckets');
      let bucket = await buckets.findOne({
        filter: { patternId: input.patternId, bucketDate: date },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!bucket) {
        bucket = await buckets.create({
          values: { patternId: input.patternId, bucketDate: date },
          transaction,
        });
      }
      const dailyBuckets = await buckets.find({
        filter: { bucketDate: date },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });

      this.assertRunBudget(run, input.policy, delta);
      this.assertDailyBudget(bucket, input.policy, delta);
      this.assertGlobalDailyBudget(dailyBuckets, control, delta);
      await runs.update({
        filterByTk: input.runId,
        values: {
          invocationCount: storedCount(read(run, 'invocationCount'), 'Run invocation') + delta.invocations,
          toolCallCount: storedCount(read(run, 'toolCallCount'), 'Run tool call') + delta.toolCalls,
          delegationCount: storedCount(read(run, 'delegationCount'), 'Run delegation') + delta.delegations,
          verificationCount: storedCount(read(run, 'verificationCount'), 'Run verification') + delta.verifications,
          totalInputTokens: storedCount(read(run, 'totalInputTokens'), 'Run input token') + delta.inputTokens,
          totalOutputTokens: storedCount(read(run, 'totalOutputTokens'), 'Run output token') + delta.outputTokens,
          totalTokens: storedCount(read(run, 'totalTokens'), 'Run total token') + delta.totalTokens,
          totalCost: storedCost(read(run, 'totalCost'), 'Run cost') + delta.cost,
        },
        transaction,
      });
      await buckets.update({
        filterByTk: read(bucket, 'id'),
        values: {
          invocationCount: storedCount(read(bucket, 'invocationCount'), 'Daily invocation') + delta.invocations,
          toolCallCount: storedCount(read(bucket, 'toolCallCount'), 'Daily tool call') + delta.toolCalls,
          delegationCount: storedCount(read(bucket, 'delegationCount'), 'Daily delegation') + delta.delegations,
          inputTokens: storedCount(read(bucket, 'inputTokens'), 'Daily input token') + delta.inputTokens,
          outputTokens: storedCount(read(bucket, 'outputTokens'), 'Daily output token') + delta.outputTokens,
          totalTokens: storedCount(read(bucket, 'totalTokens'), 'Daily total token') + delta.totalTokens,
          totalCost: storedCost(read(bucket, 'totalCost'), 'Daily cost') + delta.cost,
        },
        transaction,
      });
      return { reserved: delta, bucketDate: date };
    });
  }

  private assertRunBudget(run: Model, policy: LoopPatternPolicy, delta: UsageTotals) {
    const limits = policy.perRun;
    exceeds(
      storedCount(read(run, 'invocationCount'), 'Run invocation'),
      delta.invocations,
      limits.maxInvocations,
      'Per-run invocation',
    );
    exceeds(
      storedCount(read(run, 'toolCallCount'), 'Run tool call'),
      delta.toolCalls,
      limits.maxToolCalls,
      'Per-run tool call',
    );
    exceeds(
      storedCount(read(run, 'delegationCount'), 'Run delegation'),
      delta.delegations,
      limits.maxDelegations,
      'Per-run delegation',
    );
    exceeds(
      storedCount(read(run, 'verificationCount'), 'Run verification'),
      delta.verifications,
      limits.maxVerifications,
      'Per-run verification',
    );
    exceeds(
      storedCount(read(run, 'totalTokens'), 'Run total token'),
      delta.totalTokens,
      limits.maxTokens,
      'Per-run token',
    );
    exceeds(storedCost(read(run, 'totalCost'), 'Run cost'), delta.cost, limits.maxCost, 'Per-run cost');
  }

  private assertDailyBudget(bucket: Model, policy: LoopPatternPolicy, delta: UsageTotals) {
    const limits = policy.daily;
    exceeds(
      storedCount(read(bucket, 'invocationCount'), 'Daily invocation'),
      delta.invocations,
      limits.maxInvocations,
      'Daily invocation',
    );
    exceeds(
      storedCount(read(bucket, 'toolCallCount'), 'Daily tool call'),
      delta.toolCalls,
      limits.maxToolCalls,
      'Daily tool call',
    );
    exceeds(
      storedCount(read(bucket, 'delegationCount'), 'Daily delegation'),
      delta.delegations,
      limits.maxDelegations,
      'Daily delegation',
    );
    exceeds(
      storedCount(read(bucket, 'totalTokens'), 'Daily total token'),
      delta.totalTokens,
      limits.maxTokens,
      'Daily token',
    );
    exceeds(storedCost(read(bucket, 'totalCost'), 'Daily cost'), delta.cost, limits.maxCost, 'Daily cost');
  }

  private assertGlobalDailyBudget(buckets: Model[], control: Model, delta: UsageTotals) {
    const currentTokens = buckets.reduce(
      (total, bucket) => total + storedCount(read(bucket, 'totalTokens'), 'Daily total token'),
      0,
    );
    const currentCost = buckets.reduce(
      (total, bucket) => total + storedCost(read(bucket, 'totalCost'), 'Daily cost'),
      0,
    );
    exceeds(
      currentTokens,
      delta.totalTokens,
      storedLimit(read(control, 'dailyMaxTokens'), 'Global daily token'),
      'Global daily token',
    );
    exceeds(
      currentCost,
      delta.cost,
      storedLimit(read(control, 'dailyMaxCost'), 'Global daily cost'),
      'Global daily cost',
    );
  }
}
