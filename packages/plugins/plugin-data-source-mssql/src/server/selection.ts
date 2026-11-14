// SPDX-License-Identifier: Apache-2.0

import type { Database, Model } from '@nocobase/database';
import { Transaction } from 'sequelize';

/** Serialize selection edits with datasource configuration updates on the main database. */
export async function withLockedDataSource<T>(
  db: Database,
  key: string,
  work: (model: Model, transaction: Transaction) => Promise<T>,
): Promise<T> {
  let transaction: Transaction;
  for (let attempt = 0; ; attempt++) {
    try {
      transaction =
        db.sequelize.getDialect() === 'sqlite'
          ? await db.sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE })
          : await db.sequelize.transaction();
      break;
    } catch (error) {
      const detail = error as { code?: string; original?: { code?: string }; parent?: { code?: string } };
      if (![detail?.code, detail?.original?.code, detail?.parent?.code].includes('SQLITE_BUSY') || attempt >= 7) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(25 * 2 ** attempt, 400)));
    }
  }

  let result: T;
  try {
    const model = await db.getRepository('dataSources').findOne({
      filterByTk: key,
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!model) throw new Error(`Data source ${key} not found`);
    result = await work(model, transaction);
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
  await transaction.commit();
  return result;
}
