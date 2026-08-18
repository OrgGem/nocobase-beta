import type { Plugin } from '@nocobase/server';
import { LoopRunRepository } from '../services/LoopRunRepository';
import { asObject, valuesFromCtx } from '../utils/ctx-utils';
import { requestActor, throwResourceError } from './resource-helpers';

export function registerAgentLoopApprovalResource(plugin: Plugin) {
  const repository = new LoopRunRepository(plugin.db);

  plugin.app.resource({
    name: 'agentLoopApprovals',
    actions: {
      async list(ctx, next) {
        try {
          const actor = requestActor(ctx);
          const result = await repository.listApprovals({
            userId: actor.userId,
            isAdmin: actor.isAdmin,
            filter: ctx.action.params.filter || {},
            sort: ctx.action.params.sort,
            page: Number(ctx.action.params.page),
            pageSize: Number(ctx.action.params.pageSize),
          });
          ctx.body = {
            data: result.rows,
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
          const approvalId = ctx.action.params.filterByTk;
          if (!approvalId) ctx.throw(400, 'approval id is required');
          ctx.body = {
            data: await repository.requireAccessibleApproval(approvalId, actor.userId, actor.isAdmin),
          };
        } catch (error) {
          throwResourceError(ctx, error);
        }
        await next();
      },

      async decide(ctx, next) {
        try {
          const actor = requestActor(ctx);
          const approvalId = ctx.action.params.filterByTk;
          if (!approvalId) ctx.throw(400, 'approval id is required');
          const values = valuesFromCtx(ctx);
          const decision =
            values.decision === 'approve' ? 'approved' : values.decision === 'reject' ? 'rejected' : null;
          if (!decision) ctx.throw(400, 'decision must be "approve" or "reject"');
          const editedInput = values.editedInput;
          ctx.body = {
            data: await repository.decideApproval({
              approvalId,
              userId: actor.userId,
              isAdmin: actor.isAdmin,
              decision,
              note: typeof values.note === 'string' ? values.note.trim() : '',
              editedInput:
                decision === 'approved' && editedInput !== undefined
                  ? Array.isArray(editedInput)
                    ? editedInput
                    : asObject(editedInput)
                  : undefined,
            }),
          };
        } catch (error) {
          throwResourceError(ctx, error);
        }
        await next();
      },
    },
  });
}
