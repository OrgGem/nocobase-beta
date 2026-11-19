// SPDX-License-Identifier: Apache-2.0
import type { Context } from '@nocobase/actions';
import type { Plugin } from '@nocobase/server';
import { autoApprovalCall, isAutoApprovalEligible, sessionAutoApprovalEnabled } from '../services/SessionAutoApproval';
import { valuesFromCtx } from '../utils/ctx-utils';
import { read } from '../utils/record-utils';

async function ownedSession(ctx: Context): Promise<{ ownerId: number; sessionId: string }> {
  const ownerId = Number(ctx.auth?.user?.id);
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0) ctx.throw(401, ctx.t('Authentication is required.'));
  const values = valuesFromCtx(ctx);
  const sessionId = values.sessionId;
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 100) {
    ctx.throw(400, ctx.t('A conversation is required.'));
  }
  const conversation = await ctx.db
    .getRepository('aiConversations')
    .findOne({ filter: { sessionId, userId: ownerId } });
  if (!conversation || read(conversation, 'from') === 'sub-agent') {
    ctx.throw(404, ctx.t('The current conversation is unavailable.'));
  }
  return { ownerId, sessionId };
}

export function registerAgentAutoApprovalResource(plugin: Plugin) {
  plugin.app.resource({
    name: 'agentAutoApproval',
    actions: {
      async get(ctx, next) {
        const { sessionId } = await ownedSession(ctx as Context);
        ctx.body = { enabled: await sessionAutoApprovalEnabled(ctx as Context, sessionId) };
        await next();
      },
      async set(ctx, next) {
        const { ownerId, sessionId } = await ownedSession(ctx as Context);
        const { enabled } = valuesFromCtx(ctx);
        if (typeof enabled !== 'boolean') ctx.throw(400, ctx.t('An auto-approval setting is required.'));
        await ctx.db.getModel('agentSessionAutoApprovals').upsert({ ownerId, sessionId, enabled });
        ctx.body = { enabled };
        await next();
      },
      async eligible(ctx, next) {
        await ownedSession(ctx as Context);
        const call = autoApprovalCall(valuesFromCtx(ctx));
        if (!call) return ctx.throw(400, ctx.t('A tool call is required.'));
        ctx.body = { eligible: await isAutoApprovalEligible(ctx as Context, call) };
        await next();
      },
    },
  });
}
