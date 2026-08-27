import { randomUUID } from 'node:crypto';
import type { Database, Model, Transaction } from '@nocobase/database';
import { LoopControlService } from './LoopControlService';
import { loopPatternPolicySchema } from './LoopPatternSchema';
import { getRunEventBus } from './RunEventBus';
import { isPassingVerification } from './VerificationSchema';
import { read } from '../utils/record-utils';

export const loopRunStatuses = [
  'queued',
  'preparing',
  'waiting_lock',
  'running',
  'waiting_approval',
  'verifying',
  'waiting_human',
  'paused',
  'blocked',
  'succeeded',
  'failed',
  'canceled',
] as const;

export type LoopRunStatus = (typeof loopRunStatuses)[number];

const transitions: Record<LoopRunStatus, ReadonlySet<LoopRunStatus>> = {
  queued: new Set(['preparing', 'paused', 'blocked', 'canceled']),
  preparing: new Set([
    'queued',
    'waiting_lock',
    'waiting_approval',
    'running',
    'paused',
    'blocked',
    'failed',
    'canceled',
  ]),
  waiting_lock: new Set(['preparing', 'paused', 'blocked', 'canceled']),
  running: new Set([
    'queued',
    'waiting_approval',
    'verifying',
    'waiting_human',
    'paused',
    'blocked',
    'failed',
    'canceled',
  ]),
  waiting_approval: new Set(['queued', 'running', 'waiting_human', 'paused', 'blocked', 'failed', 'canceled']),
  verifying: new Set(['running', 'waiting_human', 'paused', 'blocked', 'succeeded', 'failed', 'canceled']),
  waiting_human: new Set(['running', 'succeeded', 'failed', 'canceled']),
  paused: new Set(['queued', 'preparing', 'running', 'waiting_approval', 'verifying', 'blocked', 'canceled']),
  blocked: new Set(['queued', 'waiting_human', 'failed', 'canceled']),
  succeeded: new Set(),
  failed: new Set(['queued']),
  canceled: new Set(),
};

export type TransitionInput = {
  from: LoopRunStatus;
  to: LoopRunStatus;
  runtimeVersion?: string;
  verifierEvidence?: unknown;
  humanAccepted?: boolean;
};

export function assertRunTransition(input: TransitionInput) {
  if (input.runtimeVersion && input.runtimeVersion !== 'control-plane-v2') {
    throw new Error('Historical plan-era runs are read-only.');
  }
  if (input.from === input.to) {
    throw new Error(`Run is already ${input.to}.`);
  }
  if (!transitions[input.from].has(input.to)) {
    throw new Error(`Illegal run transition: ${input.from} -> ${input.to}.`);
  }
  if (input.to === 'succeeded') {
    if (!isPassingVerification(input.verifierEvidence)) {
      throw new Error('A run cannot succeed without a structured passing verifier verdict.');
    }
    if (input.from === 'waiting_human' && input.humanAccepted !== true) {
      throw new Error('Human acceptance is required to finish a run waiting for human review.');
    }
  }
}

function asStatus(value: unknown): LoopRunStatus {
  if (typeof value === 'string' && (loopRunStatuses as readonly string[]).includes(value)) {
    return value as LoopRunStatus;
  }
  throw new Error(`Unknown Loop Control Plane run status: ${String(value)}.`);
}

const activeExecutionStatuses: LoopRunStatus[] = ['preparing', 'running', 'verifying'];
const claimableStatuses: LoopRunStatus[] = ['queued', 'waiting_lock'];

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function leaseIsExpired(record: Model | Record<string, unknown>, now: Date) {
  const lockedUntil = asDate(read(record, 'lockedUntil'));
  return !lockedUntil || lockedUntil.getTime() <= now.getTime();
}

function leaseOwner(record: Model | Record<string, unknown>) {
  const owner = read(record, 'lockedBy');
  return typeof owner === 'string' && owner.trim() ? owner : null;
}

// Only a run someone actually claimed can lose its lease. An active run with no owner still
// occupies a concurrency slot: requeueing it would dispatch work that may already be running.
function leaseIsReclaimable(record: Model | Record<string, unknown>, now: Date) {
  return leaseOwner(record) !== null && leaseIsExpired(record, now);
}

function asPositiveInteger(value: unknown, label: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} is invalid.`);
  return parsed;
}

function asPlain(record: Model | Record<string, unknown>) {
  return typeof (record as Model).toJSON === 'function'
    ? ((record as Model).toJSON() as Record<string, unknown>)
    : structuredClone(record as Record<string, unknown>);
}

export type ClaimedLoopRun = {
  run: Record<string, unknown>;
  leaseToken: string;
  leaseUntil: Date;
};

export class LoopRunStateMachine {
  private readonly control: LoopControlService;

  constructor(private readonly database: Database) {
    this.control = new LoopControlService(database);
  }

  async claimNext(workerId: string, leaseMs: number): Promise<ClaimedLoopRun | null> {
    const normalizedWorkerId = workerId.trim();
    if (!normalizedWorkerId) throw new Error('Worker identity is required.');
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 5_000) throw new Error('Worker lease must be at least 5000ms.');

    const committed = await this.database.sequelize.transaction(async (transaction) => {
      const control = await this.control.getForUpdate(transaction);
      if (control.state !== 'running')
        return { claimed: null, blockedEvents: [] as Array<{ runId: number; event: unknown }> };

      const runs = this.database.getRepository('agentLoopRuns');
      const now = new Date();
      const reclaimedEvents: Array<{ runId: number; event: unknown }> = [];

      // A worker that crashed mid-run leaves an active status behind with a lease that
      // eventually expires. Those runs must be returned to the queue before concurrency is
      // measured, otherwise each crash permanently consumes a slot.
      const staleActive = await runs.find({
        filter: { runtimeVersion: 'control-plane-v2', status: { $in: activeExecutionStatuses } },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      for (const candidate of staleActive) {
        if (!leaseIsReclaimable(candidate, now)) continue;
        const runId = asPositiveInteger(read(candidate, 'id'), 'Run identifier');
        const from = asStatus(read(candidate, 'status'));
        assertRunTransition({
          from,
          to: 'queued',
          runtimeVersion: String(read(candidate, 'runtimeVersion') || ''),
        });
        await runs.update({
          filterByTk: runId,
          values: { status: 'queued', lockedBy: null, lockedUntil: null },
          transaction,
        });
        const event = await this.createEvent(
          {
            runId,
            type: 'run_lease_expired',
            title: 'Worker lease expired',
            content: `Run returned to the queue after its ${from} worker lease expired.`,
            status: 'queued',
            payload: { from, previousOwner: read(candidate, 'lockedBy') ?? null },
            actorType: 'system',
            actorIdentity: normalizedWorkerId,
            correlationKey: `lease-expired:${runId}:${String(read(candidate, 'lockedBy') || '')}`,
            createdAt: now,
          },
          transaction,
        );
        reclaimedEvents.push({ runId, event });
      }

      const activeGlobal = await this.countActive(runs, {}, transaction, now);
      if (activeGlobal >= control.globalMaxConcurrency) {
        return { claimed: null, blockedEvents: reclaimedEvents };
      }

      const candidates = await runs.find({
        filter: { runtimeVersion: 'control-plane-v2', status: { $in: claimableStatuses } },
        sort: ['createdAt', 'id'],
        limit: 100,
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const blockedEvents: Array<{ runId: number; event: unknown }> = [...reclaimedEvents];

      for (const candidate of candidates) {
        const runId = asPositiveInteger(read(candidate, 'id'), 'Run identifier');
        const patternId = Number(read(candidate, 'patternId'));
        const pattern =
          Number.isSafeInteger(patternId) && patternId > 0
            ? await this.database.getRepository('agentLoopPatterns').findOne({
                filterByTk: patternId,
                transaction,
                lock: transaction.LOCK.UPDATE,
              })
            : null;
        let blockedReason = '';
        if (!Number.isSafeInteger(patternId) || patternId <= 0) blockedReason = 'Run has no valid pattern snapshot.';
        else if (!pattern) blockedReason = 'Loop pattern was deleted.';
        else if (read(pattern, 'enabled') !== true) blockedReason = 'Loop pattern is disabled.';

        const parsedPolicy = loopPatternPolicySchema.safeParse(read(candidate, 'policySnapshot'));
        if (!blockedReason && !parsedPolicy.success) blockedReason = 'Run policy snapshot is invalid.';
        if (blockedReason) {
          assertRunTransition({
            from: asStatus(read(candidate, 'status')),
            to: 'blocked',
            runtimeVersion: String(read(candidate, 'runtimeVersion') || ''),
          });
          await runs.update({
            filterByTk: runId,
            values: { status: 'blocked', blockedReason, lockedBy: null, lockedUntil: null },
            transaction,
          });
          const event = await this.createEvent(
            {
              runId,
              type: 'run_blocked',
              title: 'Run blocked',
              content: blockedReason,
              status: 'blocked',
              payload: { reason: blockedReason },
              actorType: 'worker',
              actorIdentity: normalizedWorkerId,
              correlationKey: `claim-blocked:${runId}`,
              createdAt: now,
            },
            transaction,
          );
          blockedEvents.push({ runId, event });
          continue;
        }

        const activePattern = await this.countActive(runs, { patternId }, transaction, now);
        if (activePattern >= parsedPolicy.data.maxConcurrency) continue;

        const leaseToken = `${normalizedWorkerId}:${randomUUID()}`;
        const leaseUntil = new Date(now.getTime() + leaseMs);
        assertRunTransition({
          from: asStatus(read(candidate, 'status')),
          to: 'preparing',
          runtimeVersion: String(read(candidate, 'runtimeVersion') || ''),
        });
        await runs.update({
          filterByTk: runId,
          values: { status: 'preparing', blockedReason: null, lockedBy: leaseToken, lockedUntil: leaseUntil },
          transaction,
        });
        const event = await this.createEvent(
          {
            runId,
            type: 'run_claimed',
            title: 'Run claimed',
            content: `Run claimed by worker ${normalizedWorkerId}.`,
            status: 'preparing',
            payload: { workerId: normalizedWorkerId, leaseUntil: leaseUntil.toISOString() },
            actorType: 'worker',
            actorIdentity: normalizedWorkerId,
            correlationKey: `claim:${leaseToken}`,
            createdAt: now,
          },
          transaction,
        );
        return {
          claimed: {
            run: { ...asPlain(candidate), status: 'preparing', lockedBy: leaseToken, lockedUntil: leaseUntil },
            leaseToken,
            leaseUntil,
            runId,
            event,
          },
          blockedEvents,
        };
      }
      return { claimed: null, blockedEvents };
    });

    for (const blocked of committed.blockedEvents) getRunEventBus().emit(blocked.runId, blocked.event);
    if (!committed.claimed) return null;
    getRunEventBus().emit(committed.claimed.runId, committed.claimed.event);
    return {
      run: committed.claimed.run,
      leaseToken: committed.claimed.leaseToken,
      leaseUntil: committed.claimed.leaseUntil,
    };
  }

  // Approval windows fail closed: an unanswered request blocks the run instead of silently
  // turning into an approval. Runs only move while they are still `waiting_approval`, so a
  // decision recorded through another path always wins the race against this sweep.
  async expireOverdueApprovals(now: Date): Promise<number[]> {
    const blockedRunIds: number[] = [];
    const committedEvents: Array<{ runId: number; event: unknown }> = [];

    await this.database.sequelize.transaction(async (transaction) => {
      const approvals = this.database.getRepository('agentLoopActionApprovals');
      const runs = this.database.getRepository('agentLoopRuns');
      const pending = await approvals.find({ filter: { status: 'pending' }, transaction });

      const overdueByRun = new Map<number, Array<Model | Record<string, unknown>>>();
      for (const approval of pending) {
        const expiresAt = asDate(read(approval, 'expiresAt'));
        if (!expiresAt || expiresAt.getTime() > now.getTime()) continue;
        const runId = Number(read(approval, 'runId'));
        if (!Number.isSafeInteger(runId) || runId <= 0) continue;
        const bucket = overdueByRun.get(runId) || [];
        bucket.push(approval);
        overdueByRun.set(runId, bucket);
      }

      for (const [runId, overdue] of overdueByRun) {
        const run = await runs.findOne({ filterByTk: runId, transaction, lock: transaction.LOCK.UPDATE });
        if (!run) continue;
        if (String(read(run, 'runtimeVersion')) !== 'control-plane-v2') continue;
        if (asStatus(read(run, 'status')) !== 'waiting_approval') continue;

        assertRunTransition({
          from: 'waiting_approval',
          to: 'blocked',
          runtimeVersion: String(read(run, 'runtimeVersion') || ''),
        });

        for (const approval of overdue) {
          await approvals.update({
            filterByTk: Number(read(approval, 'id')),
            values: { status: 'expired', decidedAt: now },
            transaction,
          });
        }

        const reason = `${overdue.length} action approval(s) expired before a decision was made.`;
        await runs.update({
          filterByTk: runId,
          values: {
            status: 'blocked',
            blockedReason: reason,
            approvalStatus: 'expired',
            lockedBy: null,
            lockedUntil: null,
          },
          transaction,
        });
        const event = await this.createEvent(
          {
            runId,
            type: 'run_approval_expired',
            title: 'Approval window expired',
            content: reason,
            status: 'blocked',
            payload: { reason, expiredApprovals: overdue.length },
            actorType: 'system',
            actorIdentity: 'approval-reaper',
            correlationKey: `approval-expired:${runId}`,
            createdAt: now,
          },
          transaction,
        );
        blockedRunIds.push(runId);
        committedEvents.push({ runId, event });
      }
    });

    for (const blocked of committedEvents) getRunEventBus().emit(blocked.runId, blocked.event);
    return blockedRunIds;
  }

  async renewLease(runId: number, leaseToken: string, leaseMs: number) {
    if (!leaseToken.trim()) throw new Error('Worker lease token is required.');
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 5_000) throw new Error('Worker lease must be at least 5000ms.');
    return this.database.sequelize.transaction(async (transaction) => {
      const runs = this.database.getRepository('agentLoopRuns');
      const run = await runs.findOne({ filterByTk: runId, transaction, lock: transaction.LOCK.UPDATE });
      if (!run || read(run, 'lockedBy') !== leaseToken)
        throw new Error('Worker lease is no longer owned by this worker.');
      if (String(read(run, 'runtimeVersion')) !== 'control-plane-v2')
        throw new Error('Historical plan-era runs are read-only.');
      if (!activeExecutionStatuses.includes(asStatus(read(run, 'status')))) {
        throw new Error('Only actively executing runs can renew a worker lease.');
      }
      const leaseUntil = new Date(Date.now() + leaseMs);
      await runs.update({ filterByTk: runId, values: { lockedUntil: leaseUntil }, transaction });
      return leaseUntil;
    });
  }

  async releaseLease(runId: number, leaseToken: string) {
    if (!leaseToken.trim()) throw new Error('Worker lease token is required.');
    return this.database.sequelize.transaction(async (transaction) => {
      const runs = this.database.getRepository('agentLoopRuns');
      const run = await runs.findOne({ filterByTk: runId, transaction, lock: transaction.LOCK.UPDATE });
      if (!run) return false;
      if (read(run, 'lockedBy') !== leaseToken) throw new Error('Worker lease is no longer owned by this worker.');
      await runs.update({ filterByTk: runId, values: { lockedBy: null, lockedUntil: null }, transaction });
      return true;
    });
  }

  async transition(input: {
    runId: number;
    to: LoopRunStatus;
    actorType: string;
    actorIdentity: string;
    eventType?: string;
    title?: string;
    content?: string;
    correlationKey?: string;
    leaseToken?: string;
    values?: Record<string, unknown>;
    humanAccepted?: boolean;
  }) {
    const committed = await this.database.sequelize.transaction(async (transaction) => {
      const runs = this.database.getRepository('agentLoopRuns');
      const run = await runs.findOne({
        filterByTk: input.runId,
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!run) throw new Error(`Agent loop run ${input.runId} was not found.`);

      if (input.actorType === 'worker') {
        if (!input.leaseToken?.trim() || read(run, 'lockedBy') !== input.leaseToken) {
          throw new Error('Worker lease is no longer owned by this worker.');
        }
        if (leaseIsExpired(run, new Date())) throw new Error('Worker lease has expired.');
      }

      const from = asStatus(read(run, 'status'));

      // The transition table permits `paused -> running/verifying` because that is how a human
      // resumes a run. A worker must not use those edges: a run paused or canceled mid-invocation
      // would otherwise be carried forward by the worker that was already executing it, and the
      // pause would only take effect on the next claim.
      if (input.actorType === 'worker' && !activeExecutionStatuses.includes(from)) {
        throw new Error(`A worker cannot transition a run that is ${from}.`);
      }

      const verifierEvidence = input.values?.verifierEvidence ?? read(run, 'verifierEvidence');
      assertRunTransition({
        from,
        to: input.to,
        runtimeVersion: String(read(run, 'runtimeVersion') || ''),
        verifierEvidence,
        humanAccepted: input.humanAccepted,
      });

      const now = new Date();
      await runs.update({
        filterByTk: input.runId,
        values: {
          ...(input.values || {}),
          status: input.to,
          ...(input.to === 'running' && !read(run, 'startedAt') ? { startedAt: now } : {}),
          ...(['succeeded', 'failed', 'canceled'].includes(input.to) ? { endedAt: now } : {}),
        },
        transaction,
      });
      const event = await this.createEvent(
        {
          runId: input.runId,
          type: input.eventType || 'run_status_changed',
          title: input.title || `Run ${input.to}`,
          content: input.content || `${from} -> ${input.to}`,
          status: input.to,
          payload: { from, to: input.to },
          actorType: input.actorType,
          actorIdentity: input.actorIdentity,
          correlationKey: input.correlationKey,
          createdAt: now,
        },
        transaction,
      );
      return { from, to: input.to, event };
    });

    getRunEventBus().emit(input.runId, committed.event);
    return committed;
  }

  private async countActive(
    runs: ReturnType<Database['getRepository']>,
    filter: Record<string, unknown>,
    transaction: Transaction,
    now: Date,
  ) {
    const rows = await runs.find({
      filter: { ...filter, runtimeVersion: 'control-plane-v2', status: { $in: activeExecutionStatuses } },
      transaction,
    });
    return rows.filter((row) => !leaseIsReclaimable(row, now)).length;
  }

  private async createEvent(values: Record<string, unknown>, transaction: Transaction) {
    const record = await this.database.getRepository('agentLoopEvents').create({ values, transaction });
    return typeof record.toJSON === 'function' ? record.toJSON() : record;
  }
}
