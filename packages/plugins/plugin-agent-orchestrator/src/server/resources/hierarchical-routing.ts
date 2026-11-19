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
import { HierarchicalAgentRuntime } from '../services/HierarchicalAgentRuntime';
import { valuesFromCtx } from '../utils/ctx-utils';
import { requireAdminActor, throwResourceError } from './resource-helpers';

/** Preview uses the requesting administrator's own real session and the runtime's resolver. */
export function registerHierarchicalRoutingResource(plugin: Plugin) {
  const runtime = new HierarchicalAgentRuntime(plugin);
  plugin.app.resource({
    name: 'agentHierarchy',
    actions: {
      async preview(ctx, next) {
        const values = valuesFromCtx(ctx);
        const username = typeof values.username === 'string' ? values.username.trim() : '';
        const sessionId = typeof values.sessionId === 'string' ? values.sessionId.trim() : '';
        const specialistUsername =
          typeof values.specialistUsername === 'string' ? values.specialistUsername.trim() : '';
        if (!username || !sessionId) ctx.throw(400, ctx.t('A conversation and target employee are required.'));
        try {
          requireAdminActor(ctx as Context);
          ctx.body = { data: await runtime.preview(ctx as Context, username, specialistUsername || undefined) };
        } catch (error) {
          throwResourceError(ctx as Context, error);
        }
        await next();
      },
    },
  });
}
