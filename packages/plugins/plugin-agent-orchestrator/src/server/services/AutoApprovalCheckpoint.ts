// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import type { Context } from '@nocobase/actions';
import { asRecord, read } from '../utils/record-utils';
import type { AutoApprovalCall } from './SessionAutoApproval';

export type AutoApprovalCheckpoint = {
  checkpointKey: string;
  ownerId: number;
  sessionId: string;
  messageId: string;
  interruptId: string;
  callIds: string[];
};

/** Read the checkpoint from a conversation owned by the caller. */
export async function autoApprovalCheckpoint(
  ctx: Context,
  call: AutoApprovalCall,
): Promise<AutoApprovalCheckpoint | null | undefined> {
  const ownerId = Number(ctx.auth?.user?.id);
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0) return undefined;
  const conversation = await ctx.db.getRepository('aiConversations').findOne({
    filter: { sessionId: call.sessionId, userId: ownerId },
  });
  if (!conversation || read(conversation, 'from') === 'sub-agent') return undefined;
  const username = read(conversation, 'aiEmployeeUsername');
  if (typeof username !== 'string' || !username) return undefined;
  const message = await ctx.db.getRepository('aiMessages').findOne({
    filter: { sessionId: call.sessionId, messageId: call.messageId, role: username },
  });
  const calls = read(message, 'toolCalls');
  if (!Array.isArray(calls) || !calls.length) return undefined;
  const callIds = calls.map((item) => asRecord(item).id);
  if (
    call.messageId.length > 100 ||
    callIds.some((id) => typeof id !== 'string' || !id) ||
    new Set(callIds).size !== callIds.length ||
    !callIds.includes(call.toolCallId)
  )
    return undefined;
  const interruptId = asRecord(read(message, 'metadata')).interruptId;
  if (typeof interruptId !== 'string' || !interruptId) return undefined;
  if (callIds.length === 1) return null;
  const checkpointKey = createHash('sha256')
    .update(JSON.stringify([ownerId, call.sessionId, call.messageId, interruptId]))
    .digest('hex');
  return {
    checkpointKey,
    ownerId,
    sessionId: call.sessionId,
    messageId: call.messageId,
    interruptId,
    callIds: callIds as string[],
  };
}

/** Enroll once before an automatic decision reaches the native action. */
export async function enrollAutoApprovalCheckpoint(ctx: Context, checkpoint: AutoApprovalCheckpoint) {
  const model = ctx.db.getModel('agentAutoApprovalCheckpoints');
  const where = { checkpointKey: checkpoint.checkpointKey };
  if (await model.findOne({ where })) return;
  try {
    await model.create({
      ...where,
      ownerId: checkpoint.ownerId,
      sessionId: checkpoint.sessionId,
      messageId: checkpoint.messageId,
      interruptId: checkpoint.interruptId,
      status: 'pending',
    });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'SequelizeUniqueConstraintError') throw error;
    if (!(await model.findOne({ where }))) throw error;
  }
}

/** Native decisions are retained; only one callback may execute frontend tools and resume. */
export async function coordinateAutoApprovalDecision(
  ctx: Context,
  checkpoint: AutoApprovalCheckpoint,
  call: AutoApprovalCall,
) {
  const model = ctx.db.getModel('agentAutoApprovalCheckpoints');
  const where = { checkpointKey: checkpoint.checkpointKey, ownerId: checkpoint.ownerId };
  if (!(await model.findOne({ where }))) return;
  const body = asRecord(ctx.body);
  const originalUpdated = body.updated;
  const calls = Array.isArray(body.toolCalls) ? body.toolCalls.map(asRecord) : [];
  const ids = calls.map((item) => item.id);
  const validSnapshot =
    calls.length === checkpoint.callIds.length &&
    ids.every((id) => typeof id === 'string' && checkpoint.callIds.includes(id)) &&
    new Set(ids).size === ids.length &&
    calls.every((item) => typeof item.willInterrupt === 'boolean');
  const current = await autoApprovalCheckpoint(ctx, call);
  let sameCheckpoint =
    current?.checkpointKey === checkpoint.checkpointKey &&
    current.callIds.length === checkpoint.callIds.length &&
    current.callIds.every((id) => checkpoint.callIds.includes(id));
  const interruptedCalls = calls.filter((item) => item.willInterrupt === true);
  const ready =
    validSnapshot &&
    sameCheckpoint &&
    interruptedCalls.some((item) => item.id === call.toolCallId) &&
    interruptedCalls.every((item) => item.invokeStatus === 'waiting');
  let canFinalize = false;
  if (originalUpdated === 1 && ready) {
    canFinalize = await ctx.db.sequelize.transaction(async (transaction) => {
      const message = await ctx.db.getModel('aiMessages').findOne({
        where: { sessionId: checkpoint.sessionId, messageId: checkpoint.messageId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const messageCalls = read(message, 'toolCalls');
      const messageIds = Array.isArray(messageCalls) ? messageCalls.map((item) => asRecord(item).id) : [];
      sameCheckpoint =
        asRecord(read(message, 'metadata')).interruptId === checkpoint.interruptId &&
        messageIds.length === checkpoint.callIds.length &&
        messageIds.every((id) => typeof id === 'string' && checkpoint.callIds.includes(id)) &&
        new Set(messageIds).size === messageIds.length;
      if (!sameCheckpoint) return false;
      const [updated] = await model.update(
        { status: 'issued' },
        { where: { ...where, status: 'pending' }, transaction },
      );
      return updated === 1;
    });
  }
  ctx.body = {
    ...body,
    updated: canFinalize ? originalUpdated : 0,
    agentAutoApprovalCheckpoint: {
      interruptId: checkpoint.interruptId,
      decisionRecorded: originalUpdated === 1,
      canFinalize,
      validSnapshot: validSnapshot && sameCheckpoint,
    },
  };
}
