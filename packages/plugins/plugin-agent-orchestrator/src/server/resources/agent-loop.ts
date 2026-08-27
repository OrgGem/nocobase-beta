import { randomUUID } from 'node:crypto';
import type { Plugin } from '@nocobase/server';
import { LoopPatternService } from '../services/LoopPatternService';
import { LoopRunRepository } from '../services/LoopRunRepository';
import { LoopRunStateMachine, type LoopRunStatus, loopRunStatuses } from '../services/LoopRunStateMachine';
import { LoopTriggerService } from '../services/LoopTriggerService';
import { loopWorkerAbortMessage } from '../services/LoopWorkerService';
import { asObject, valuesFromCtx } from '../utils/ctx-utils';
import { employeeHarnessResolver, worktreeCapability } from '../utils/loop-pattern-context';
import { requestActor, throwResourceError } from './resource-helpers';

type LoopResourcePlugin = Plugin & { loopWorker?: { abortRun(runId: number): void } };

function formatRunRow(row: Record<string, unknown>) {
  return {
    ...row,
    historical: row.runtimeVersion !== 'control-plane-v2',
    readOnly: row.runtimeVersion !== 'control-plane-v2',
  };
}

function runIdFromContext(ctx: Parameters<typeof requestActor>[0]) {
  const values = valuesFromCtx(ctx);
  return values.runId || ctx.action.params.filterByTk;
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function statusValue(value: unknown): LoopRunStatus {
  if (typeof value === 'string' && (loopRunStatuses as readonly string[]).includes(value)) {
    return value as LoopRunStatus;
  }
  throw new Error(`Unknown Loop Control Plane run status: ${String(value)}.`);
}

function manualAllowedUserIds(pattern: Record<string, unknown>) {
  const triggerConfig = asObject(pattern.triggerConfig);
  const configured = triggerConfig.allowedUserIds;
  if (!Array.isArray(configured)) return [];
  return configured.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
}

// Transitioning the row does not stop work that is already in flight: the invocation lives in the
// worker's `AbortController` on whichever node claimed the run. `sendSyncMessage` publishes with
// `skipSelf`, so the local worker is aborted directly and the message covers the other nodes.
async function abortRunEverywhere(plugin: LoopResourcePlugin, runId: number) {
  plugin.loopWorker?.abortRun(runId);
  await plugin.sendSyncMessage(loopWorkerAbortMessage(runId));
}

async function transitionOwnedRun(
  plugin: LoopResourcePlugin,
  stateMachine: LoopRunStateMachine,
  repository: LoopRunRepository,
  ctx: Parameters<typeof requestActor>[0],
  to: LoopRunStatus,
  input?: { values?: Record<string, unknown>; humanAccepted?: boolean; eventType?: string; abort?: boolean },
) {
  const actor = requestActor(ctx);
  const runId = runIdFromContext(ctx);
  if (!runId) ctx.throw(400, 'runId is required');
  await repository.requireMutableV2Run(runId, actor.userId, actor.isAdmin);
  const transitioned = await stateMachine.transition({
    runId: Number(runId),
    to,
    actorType: 'human',
    actorIdentity: String(actor.userId),
    eventType: input?.eventType,
    values: input?.values,
    humanAccepted: input?.humanAccepted,
  });
  if (input?.abort) await abortRunEverywhere(plugin, Number(runId));
  return transitioned;
}

export function registerAgentLoopResource(plugin: LoopResourcePlugin) {
  const repository = new LoopRunRepository(plugin.db);
  const stateMachine = new LoopRunStateMachine(plugin.db);
  const patterns = new LoopPatternService(plugin.db, employeeHarnessResolver(plugin), async () =>
    worktreeCapability(plugin),
  );
  const triggers = new LoopTriggerService(plugin.db, patterns, plugin.app.log);

  plugin.app.resource({
    name: 'agentLoops',
    actions: {
      async list(ctx, next) {
        try {
          const actor = requestActor(ctx);
          const result = await repository.listOwnedRuns({
            userId: actor.userId,
            isAdmin: actor.isAdmin,
            filter: ctx.action.params.filter || {},
            sort: ctx.action.params.sort,
            page: Number(ctx.action.params.page),
            pageSize: Number(ctx.action.params.pageSize),
          });
          ctx.body = {
            data: result.rows.map(formatRunRow),
            meta: {
              count: result.count,
              page: result.page,
              pageSize: result.pageSize,
              totalPage: result.totalPage,
            },
          };
        } catch (error) {
          throwResourceError(ctx, error);
        }
        await next();
      },

      async get(ctx, next) {
        try {
          const actor = requestActor(ctx);
          const runId = runIdFromContext(ctx);
          if (!runId) ctx.throw(400, 'run id is required');
          ctx.body = { data: await repository.getOwnedRunDetail(runId, actor.userId, actor.isAdmin) };
        } catch (error) {
          throwResourceError(ctx, error);
        }
        await next();
      },

      async runNow(ctx, next) {
        try {
          const actor = requestActor(ctx);
          const values = valuesFromCtx(ctx);
          const patternId = Number(values.patternId || ctx.action.params.filterByTk);
          if (!Number.isSafeInteger(patternId) || patternId <= 0) ctx.throw(400, 'patternId is required');
          const { pattern } = await patterns.get(patternId);
          if (
            !actor.isAdmin &&
            !manualAllowedUserIds(pattern as unknown as Record<string, unknown>).includes(actor.userId)
          ) {
            ctx.throw(403, 'This loop pattern does not allow manual runs for the current user.');
          }
          const requestedTriggerKey = stringValue(values.triggerKey);
          const result = await triggers.enqueue({
            patternId,
            triggerType: 'manual',
            triggerKey: requestedTriggerKey || `manual:${actor.userId}:${randomUUID()}`,
            triggerPayload: asObject(values.triggerPayload),
            userId: actor.userId,
            goal: stringValue(values.goal) || undefined,
            perRunHarness: values.perRunHarness,
          });
          ctx.body = { data: result };
        } catch (error) {
          throwResourceError(ctx, error);
        }
        await next();
      },

      async pause(ctx, next) {
        try {
          ctx.body = {
            data: await transitionOwnedRun(plugin, stateMachine, repository, ctx, 'paused', { abort: true }),
          };
        } catch (error) {
          throwResourceError(ctx, error);
        }
        await next();
      },

      async resume(ctx, next) {
        try {
          ctx.body = { data: await transitionOwnedRun(plugin, stateMachine, repository, ctx, 'queued') };
        } catch (error) {
          throwResourceError(ctx, error);
        }
        await next();
      },

      async cancel(ctx, next) {
        try {
          const values = valuesFromCtx(ctx);
          ctx.body = {
            data: await transitionOwnedRun(plugin, stateMachine, repository, ctx, 'canceled', {
              values: { summary: stringValue(values.reason) || 'Canceled by user.' },
              eventType: 'run_canceled',
              abort: true,
            }),
          };
        } catch (error) {
          throwResourceError(ctx, error);
        }
        await next();
      },

      async retry(ctx, next) {
        try {
          ctx.body = {
            data: await transitionOwnedRun(plugin, stateMachine, repository, ctx, 'queued', {
              // Retry is a fresh attempt from the leader: any interrupted-session resume point
              // and prior approval outcome must not leak into the new attempt.
              values: { blockedReason: null, escalationReason: null, resumeContext: null, approvalStatus: null },
              eventType: 'run_retried',
            }),
          };
        } catch (error) {
          throwResourceError(ctx, error);
        }
        await next();
      },

      async escalate(ctx, next) {
        try {
          const values = valuesFromCtx(ctx);
          ctx.body = {
            data: await transitionOwnedRun(plugin, stateMachine, repository, ctx, 'waiting_human', {
              values: { escalationReason: stringValue(values.reason) || 'Escalated by user.' },
              eventType: 'run_escalated',
            }),
          };
        } catch (error) {
          throwResourceError(ctx, error);
        }
        await next();
      },

      async acceptResult(ctx, next) {
        try {
          ctx.body = {
            data: await transitionOwnedRun(plugin, stateMachine, repository, ctx, 'succeeded', {
              humanAccepted: true,
              eventType: 'run_result_accepted',
            }),
          };
        } catch (error) {
          throwResourceError(ctx, error);
        }
        await next();
      },

      async status(ctx, next) {
        try {
          const actor = requestActor(ctx);
          const runId = runIdFromContext(ctx);
          if (!runId) ctx.throw(400, 'runId is required');
          const run = await repository.requireOwnedRun(runId, actor.userId, actor.isAdmin);
          ctx.body = { data: { id: run.id, status: statusValue(run.status), runtimeVersion: run.runtimeVersion } };
        } catch (error) {
          throwResourceError(ctx, error);
        }
        await next();
      },
    },
  });
}
