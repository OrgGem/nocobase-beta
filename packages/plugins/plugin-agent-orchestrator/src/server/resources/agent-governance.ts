/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context } from '@nocobase/actions';
import type { Plugin } from '@nocobase/server';
import { AgentGovernanceService } from '../services/AgentGovernanceService';
import { valuesFromCtx } from '../utils/ctx-utils';
import { requireAdminActor } from './resource-helpers';
import { LoopRunAccessError } from '../services/LoopRunRepository';

class GovernanceValidationError extends Error {}

function governanceError(ctx: Context, error: unknown): never {
  const status =
    error instanceof LoopRunAccessError ? error.status : error instanceof GovernanceValidationError ? 400 : 409;
  const message = error instanceof Error ? error.message : 'The requested operation could not be completed.';
  return ctx.throw(status, ctx.t(message));
}

export function registerAgentGovernanceResource(plugin: Plugin) {
  const service = new AgentGovernanceService(plugin.db);
  plugin.app.resource({
    name: 'agentGovernance',
    actions: {
      async list(ctx, next) {
        try {
          requireAdminActor(ctx as Context);
          const params = ctx.action?.params || {};
          ctx.body = await service.list({ ...params, ...valuesFromCtx(ctx) });
        } catch (error) {
          governanceError(ctx as Context, error);
        }
        await next();
      },
      async listVersions(ctx, next) {
        try {
          requireAdminActor(ctx as Context);
          const values = valuesFromCtx(ctx);
          ctx.body = { data: await service.listVersions(values.policyId ?? ctx.action?.params?.filterByTk) };
        } catch (error) {
          governanceError(ctx as Context, error);
        }
        await next();
      },
      async saveDraft(ctx, next) {
        try {
          const actor = requireAdminActor(ctx as Context);
          ctx.body = { data: await service.saveDraft(valuesFromCtx(ctx), actor.userId) };
        } catch (error) {
          governanceError(ctx as Context, error);
        }
        await next();
      },
      async publish(ctx, next) {
        try {
          const actor = requireAdminActor(ctx as Context);
          const values = valuesFromCtx(ctx);
          ctx.body = {
            data: await service.publish(values.policyId, actor.userId, {
              versionId: values.versionId,
              revision: values.revision,
            }),
          };
        } catch (error) {
          governanceError(ctx as Context, error);
        }
        await next();
      },
      async rollback(ctx, next) {
        try {
          const actor = requireAdminActor(ctx as Context);
          const values = valuesFromCtx(ctx);
          if (values.version == null) throw new GovernanceValidationError('Policy version is required.');
          ctx.body = {
            data: await service.publish(values.policyId, actor.userId, { rollbackVersion: values.version }),
          };
        } catch (error) {
          governanceError(ctx as Context, error);
        }
        await next();
      },
      async preview(ctx, next) {
        try {
          requireAdminActor(ctx as Context);
          const values = valuesFromCtx(ctx);
          ctx.body = {
            data: await service.preview({
              userId: values.userId,
              employeeUsername: values.employeeUsername,
              modelKey: values.modelKey,
            }),
          };
        } catch (error) {
          governanceError(ctx as Context, error);
        }
        await next();
      },
      async apply(ctx, next) {
        try {
          const actor = requireAdminActor(ctx as Context);
          const values = valuesFromCtx(ctx);
          ctx.body = {
            data: await service.apply(
              { userId: values.userId, employeeUsername: values.employeeUsername },
              actor.userId,
            ),
          };
        } catch (error) {
          governanceError(ctx as Context, error);
        }
        await next();
      },
      async restore(ctx, next) {
        try {
          const actor = requireAdminActor(ctx as Context);
          const values = valuesFromCtx(ctx);
          ctx.body = {
            data: await service.restore(
              { userId: values.userId, employeeUsername: values.employeeUsername },
              actor.userId,
            ),
          };
        } catch (error) {
          governanceError(ctx as Context, error);
        }
        await next();
      },
      async events(ctx, next) {
        try {
          requireAdminActor(ctx as Context);
          const params = ctx.action?.params || {};
          const page = Math.max(1, Math.trunc(Number(params.page) || 1));
          const pageSize = Math.min(100, Math.max(1, Math.trunc(Number(params.pageSize) || 20)));
          const repository = plugin.db.getRepository('agentGovernanceAuditEvents');
          const [rows, count] = await Promise.all([
            repository.find({ sort: ['-id'], limit: pageSize, offset: (page - 1) * pageSize }),
            repository.count(),
          ]);
          ctx.body = { data: rows, meta: { count, page, pageSize } };
        } catch (error) {
          governanceError(ctx as Context, error);
        }
        await next();
      },
      async release(ctx, next) {
        try {
          const actor = requireAdminActor(ctx as Context);
          const values = valuesFromCtx(ctx);
          ctx.body = {
            data: await service.release(
              { userId: values.userId, employeeUsername: values.employeeUsername, expectedHash: values.expectedHash },
              actor.userId,
            ),
          };
        } catch (error) {
          governanceError(ctx as Context, error);
        }
        await next();
      },
    },
  });
}
