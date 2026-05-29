import { Plugin } from '@nocobase/server';
import { AgentLoopService } from '../services/AgentLoopService';

function toPlain(record: any) {
  return record?.toJSON?.() || record;
}

function currentUserId(ctx: any) {
  return ctx?.state?.currentUser?.id || ctx?.auth?.user?.id;
}

function values(ctx: any) {
  return ctx.request?.body || ctx.action?.params?.values || {};
}

function formatRunRow(raw: any) {
  const row = toPlain(raw);
  return {
    id: row.id,
    rootRunId: row.rootRunId,
    sessionId: row.sessionId,
    messageId: row.messageId,
    leaderUsername: row.leaderUsername,
    goal: row.goal,
    status: row.status,
    approvalStatus: row.approvalStatus,
    planVersion: row.planVersion,
    planSource: row.planSource,
    plannerModel: row.plannerModel,
    approvedById: row.approvedById,
    approvedAt: row.approvedAt,
    rejectionReason: row.rejectionReason,
    changeRequest: row.changeRequest,
    currentStepId: row.currentStepId,
    iterationCount: row.iterationCount || 0,
    finalAnswer: row.finalAnswer,
    summary: row.summary,
    userId: row.userId,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function registerAgentLoopResource(plugin: Plugin, service: AgentLoopService) {
  const app = plugin.app;

  app.resource({
    name: 'agentLoops',
    actions: {
      async list(ctx, next) {
        const { page = 1, pageSize = 20, sort = ['-createdAt'], filter = {} } = ctx.action.params;
        const repo = ctx.db.getRepository('agentLoopRuns');
        const [rows, count] = await repo.findAndCount({
          filter,
          sort,
          offset: (Number(page) - 1) * Number(pageSize),
          limit: Number(pageSize),
        });

        ctx.body = {
          data: rows.map(formatRunRow),
          meta: {
            count,
            page: Number(page),
            pageSize: Number(pageSize),
            totalPage: Math.ceil(count / Number(pageSize)),
          },
        };
        await next();
      },

      async get(ctx, next) {
        const { filterByTk } = ctx.action.params;
        if (!filterByTk) {
          ctx.throw(400, 'run id is required');
          return;
        }
        ctx.body = { data: await service.getRunDetail(filterByTk) };
        await next();
      },

      async resume(ctx, next) {
        const body = values(ctx);
        const runId = body.runId || ctx.action.params.filterByTk;
        if (!runId) {
          ctx.throw(400, 'runId is required');
          return;
        }
        ctx.body = {
          data: await service.resumeRun(runId, {
            stepId: body.stepId,
            approved: body.approved !== false,
            editedInput: body.editedInput,
            userId: currentUserId(ctx),
            ctx,
          }),
        };
        await next();
      },

      async approvePlan(ctx, next) {
        const body = values(ctx);
        const runId = body.runId || ctx.action.params.filterByTk;
        if (!runId) {
          ctx.throw(400, 'runId is required');
          return;
        }
        ctx.body = {
          data: await service.approvePlanAndExecute(runId, {
            userId: currentUserId(ctx),
            ctx,
            reason: body.reason,
          }),
        };
        await next();
      },

      async rejectPlan(ctx, next) {
        const body = values(ctx);
        const runId = body.runId || ctx.action.params.filterByTk;
        if (!runId) {
          ctx.throw(400, 'runId is required');
          return;
        }
        ctx.body = {
          data: await service.rejectPlan(runId, {
            reason: body.reason,
            userId: currentUserId(ctx),
          }),
        };
        await next();
      },

      async requestPlanChanges(ctx, next) {
        const body = values(ctx);
        const runId = body.runId || ctx.action.params.filterByTk;
        if (!runId) {
          ctx.throw(400, 'runId is required');
          return;
        }
        ctx.body = {
          data: await service.requestPlanChanges(runId, {
            feedback: body.feedback,
            userId: currentUserId(ctx),
          }),
        };
        await next();
      },

      async cancel(ctx, next) {
        const body = values(ctx);
        const runId = body.runId || ctx.action.params.filterByTk;
        if (!runId) {
          ctx.throw(400, 'runId is required');
          return;
        }
        ctx.body = {
          data: await service.cancelRun(runId, {
            reason: body.reason,
            userId: currentUserId(ctx),
          }),
        };
        await next();
      },

      async retryStep(ctx, next) {
        const body = values(ctx);
        if (!body.stepId) {
          ctx.throw(400, 'stepId is required');
          return;
        }
        ctx.body = {
          data: await service.retryStep(body.stepId, {
            userId: currentUserId(ctx),
          }),
        };
        await next();
      },
    },
  });
}
