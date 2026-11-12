// SPDX-License-Identifier: Apache-2.0

import type { Context } from '@nocobase/actions';
import type { Transaction } from 'sequelize';
import { getAuthUserId } from './access';

export async function findOwnedAiFile(ctx: Context, fileId: unknown, transaction?: Transaction) {
  const userId = getAuthUserId(ctx);
  const validId =
    (typeof fileId === 'string' && fileId.trim().length > 0) ||
    (typeof fileId === 'number' && Number.isSafeInteger(fileId));
  if (!userId || !validId) {
    ctx.throw(404, ctx.t('File not found or access denied', { ns: 'plugin-knowledge-base' }));
    return null;
  }
  const repo = ctx.db.getRepository('aiFiles');
  const file = transaction
    ? await repo.collection.model.findOne({
        where: { id: fileId, createdById: userId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      })
    : await repo.findOne({ filter: { id: fileId, createdById: userId } });
  if (!file) {
    ctx.throw(404, ctx.t('File not found or access denied', { ns: 'plugin-knowledge-base' }));
    return null;
  }
  return file;
}
