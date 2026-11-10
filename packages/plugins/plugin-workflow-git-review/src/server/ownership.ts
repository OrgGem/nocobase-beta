/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Transaction } from '@nocobase/database';
import { EXECUTION_STATUS, type default as WorkflowPlugin } from '@nocobase/plugin-workflow';
import type { ID } from './contracts';

export type LockedRequest = {
  get(key: string): unknown;
  update(values: Record<string, unknown>, options: { transaction: Transaction }): Promise<unknown>;
};

/** Lock in the same order as Git Manager recovery before modifying an owned execution. */
export async function withOwnedRequest<T>(
  workflow: WorkflowPlugin,
  requestId: ID,
  executionId: ID,
  work: (request: LockedRequest, transaction: Transaction) => Promise<T>,
): Promise<T | null> {
  const db = workflow.db;
  const run = async (transaction: Transaction): Promise<T | null> => {
    const request = await db.getCollection('gitReviewRequests').model.findOne({
      where: { id: requestId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!request || request.get('fenced') || String(request.get('executionId')) !== String(executionId)) return null;
    const execution = await db.getCollection('executions').model.findOne({
      where: { id: executionId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (
      !execution ||
      execution.get('status') !== EXECUTION_STATUS.STARTED ||
      String(execution.get('workflowId')) !== String(request.get('workflowId'))
    )
      return null;
    const expiresAt: unknown = execution.get('expiresAt');
    if (expiresAt != null) {
      const deadline =
        expiresAt instanceof Date ? expiresAt.getTime() : typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
      if (!Number.isFinite(deadline) || deadline <= Date.now()) return null;
    }
    const inbox = await db.getCollection('gitReviewInbox').model.findOne({
      where: { id: request.get('inboxId') },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!inbox || inbox.get('state') !== 'running') return null;
    const project = await db.getCollection('gitReviewProjects').model.findOne({
      where: { projectKey: inbox.get('projectKey') },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!project || String(project.get('activeInboxId')) !== String(inbox.get('id'))) return null;
    return work(request, transaction);
  };
  if (db.sequelize.getDialect() !== 'sqlite') return db.sequelize.transaction(run);

  // Only retry acquiring the SQLite write reservation. The callback may start an external operation,
  // so it and an ambiguous commit must never be repeated automatically.
  for (let attempt = 0; ; attempt++) {
    let transaction: Transaction;
    try {
      transaction = await db.sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE });
    } catch (error) {
      const detail = error as { code?: string; original?: { code?: string }; parent?: { code?: string } } | null;
      if (![detail?.code, detail?.original?.code, detail?.parent?.code].includes('SQLITE_BUSY') || attempt >= 7)
        throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(25 * 2 ** attempt, 400)));
      continue;
    }
    let result: T | null;
    try {
      result = await run(transaction);
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
    await transaction.commit();
    return result;
  }
}
