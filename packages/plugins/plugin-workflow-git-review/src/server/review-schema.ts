// SPDX-License-Identifier: Apache-2.0

import type { Database } from '@nocobase/database';
import type { ID } from './contracts';
import { isRecord } from './contracts';

export function targetsReviewCollection(config: unknown) {
  if (!isRecord(config) || typeof config.collection !== 'string') return false;
  return config.collection === 'gitReviewRequests' || config.collection.endsWith(':gitReviewRequests');
}

async function readExisting<T>(
  db: Database,
  collectionName: string,
  read: () => Promise<T>,
  missing: T,
  requiredColumn?: string,
): Promise<T> {
  const collection = db.getCollection(collectionName);
  if (!collection) return missing;
  try {
    return await read();
  } catch (error) {
    if (!(await db.collectionExistsInDb(collectionName))) return missing;
    if (requiredColumn) {
      const columns = await db.sequelize.getQueryInterface().describeTable(collection.getTableNameWithSchema());
      const attribute = collection.model.rawAttributes[requiredColumn];
      const column = attribute?.field || requiredColumn;
      if (!Object.prototype.hasOwnProperty.call(columns, column)) return missing;
    }
    throw error;
  }
}

export async function findReviewFlowBinding(
  db: Database,
  workflowKey: unknown,
): Promise<'found' | 'missing' | 'unavailable'> {
  if (typeof workflowKey !== 'string' || !workflowKey) return 'unavailable';
  const row = await readExisting(
    db,
    'gitReviewFlows',
    () => db.getRepository('gitReviewFlows').findOne({ fields: ['id'], filter: { workflowKey } }),
    undefined,
    'workflowKey',
  );
  return row === undefined ? 'unavailable' : row ? 'found' : 'missing';
}

export async function listReviewFlowKeys(db: Database): Promise<string[]> {
  const flows = await readExisting(
    db,
    'gitReviewFlows',
    () => db.getRepository('gitReviewFlows').find({ fields: ['workflowKey'] }),
    [],
    'workflowKey',
  );
  return flows.map((flow: { workflowKey?: unknown }) => String(flow.workflowKey));
}

export async function findReviewRequest(db: Database, filter: { executionId: ID } | { workflowId: ID }) {
  return readExisting(
    db,
    'gitReviewRequests',
    () =>
      db.getRepository('gitReviewRequests').findOne({ filter, ...('workflowId' in filter ? { fields: ['id'] } : {}) }),
    null,
  );
}

export async function listReviewRequests(
  db: Database,
): Promise<Array<{ executionId?: unknown; workflowId?: unknown }>> {
  return readExisting(
    db,
    'gitReviewRequests',
    () => db.getRepository('gitReviewRequests').find({ fields: ['executionId', 'workflowId'] }),
    [],
  );
}
