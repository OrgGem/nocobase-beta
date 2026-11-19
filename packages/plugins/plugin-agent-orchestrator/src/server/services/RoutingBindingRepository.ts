// SPDX-License-Identifier: Apache-2.0
import { literal, Repository, type Database, type Transaction } from '@nocobase/database';
import { read } from '../utils/record-utils';
import { RoutingCycleError, routingWouldCycle } from './RoutingBindingValidation';

const graphLockKey = 'routing';
const graphFields = ['leaderUsername', 'subAgentUsername', 'routingEnabled', 'enabled'] as const;

type CreateOptions = Parameters<Repository['create']>[0];
type UpdateOptions = Parameters<Repository['update']>[0];
type CreateManyOptions = Parameters<Repository['createMany']>[0];
type UpdateManyOptions = Parameters<Repository['updateMany']>[0];

function couldAddEdge(values: unknown): boolean {
  if (Array.isArray(values)) return values.some(couldAddEdge);
  if (!values || typeof values !== 'object') return false;
  const patch = values as Record<string, unknown>;
  const fields = graphFields.filter((field) => Object.prototype.hasOwnProperty.call(patch, field));
  return fields.some((field) => (field !== 'enabled' && field !== 'routingEnabled') || patch[field] !== false);
}

function couldCreateEdge(values: unknown): boolean {
  if (Array.isArray(values)) return values.some(couldCreateEdge);
  if (!values || typeof values !== 'object') return false;
  const value = (values as Record<string, unknown>).routingEnabled;
  return value != null && value !== false;
}

function sqliteIsBusy(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; parent?: { code?: unknown }; original?: { code?: unknown } };
  return [value.code, value.parent?.code, value.original?.code].some(
    (code) => typeof code === 'string' && /^(SQLITE_BUSY|SQLITE_LOCKED)/.test(code),
  );
}

function edgeChanged(before: unknown, after: unknown): boolean {
  return (
    !before ||
    read(before, 'leaderUsername') !== read(after, 'leaderUsername') ||
    read(before, 'subAgentUsername') !== read(after, 'subAgentUsername')
  );
}

export async function initializeRoutingGraphLock(database: Database) {
  const model = database.getModel('agentRoutingGraphLocks');
  await model.findOrCreate({ where: { key: graphLockKey }, defaults: { key: graphLockKey, marker: 0 } });
}

/** Serializes graph changes across processes until the binding transaction commits. */
export class RoutingBindingRepository extends Repository {
  private readonly graphTransactions = new WeakSet<Transaction>();

  private async withGraphLock<T>(
    suppliedTransaction: Transaction | null | undefined,
    operation: (transaction: Transaction) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      let writeStarted = false;
      const afterCommit: Array<(transaction: Transaction) => void | Promise<void>> = [];
      try {
        const result = await this.database.sequelize.transaction(
          { transaction: suppliedTransaction ?? undefined },
          async (transaction) => {
            if (suppliedTransaction) {
              // Sequelize fires savepoint afterCommit callbacks before the enclosing transaction commits.
              transaction.afterCommit = (callback) => {
                if (typeof callback !== 'function') throw new Error('afterCommit callback must be a function.');
                afterCommit.push(callback);
              };
            }
            const lockModel = this.database.getModel('agentRoutingGraphLocks');
            const [affected] = await lockModel.update(
              { marker: literal('1 - marker') },
              { where: { key: graphLockKey }, transaction },
            );
            if (affected !== 1) throw new Error('The routing graph lock has not been initialized.');

            const query = {
              filter: { routingEnabled: true, enabled: true },
              transaction,
              lock: transaction.LOCK.UPDATE,
            };
            const before = await this.find(query);
            writeStarted = true;
            this.graphTransactions.add(transaction);
            let result: T;
            try {
              result = await operation(transaction);
            } finally {
              this.graphTransactions.delete(transaction);
            }
            const after = await this.find(query);
            const previous = new Map(before.map((row) => [String(read(row, 'id')), row]));
            for (const binding of after) {
              const id = read(binding, 'id');
              const candidate = {
                leaderUsername: read(binding, 'leaderUsername'),
                subAgentUsername: read(binding, 'subAgentUsername'),
                routingEnabled: read(binding, 'routingEnabled'),
                enabled: read(binding, 'enabled'),
              };
              if (edgeChanged(previous.get(String(id)), binding) && routingWouldCycle(candidate, after, id)) {
                throw new RoutingCycleError();
              }
            }
            return result;
          },
        );
        for (const callback of afterCommit) suppliedTransaction?.afterCommit(callback);
        return result;
      } catch (error) {
        if (suppliedTransaction || writeStarted || attempt >= 3 || !sqliteIsBusy(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
      }
    }
  }

  async create(options: CreateOptions) {
    if (!couldCreateEdge(options.values) || (options.transaction && this.graphTransactions.has(options.transaction))) {
      return super.create(options);
    }
    return this.withGraphLock(options.transaction, (transaction) => super.create({ ...options, transaction }));
  }

  async createMany(options: CreateManyOptions) {
    if (!couldCreateEdge(options.records) || (options.transaction && this.graphTransactions.has(options.transaction))) {
      return super.createMany(options);
    }
    return this.withGraphLock(options.transaction, (transaction) => super.createMany({ ...options, transaction }));
  }

  async update(options: UpdateOptions) {
    if (!couldAddEdge(options.values) || (options.transaction && this.graphTransactions.has(options.transaction))) {
      return super.update(options);
    }
    return this.withGraphLock(options.transaction, (transaction) => super.update({ ...options, transaction }));
  }

  async updateMany(options: UpdateManyOptions) {
    if (!couldAddEdge(options.records) || (options.transaction && this.graphTransactions.has(options.transaction))) {
      return super.updateMany(options);
    }
    return this.withGraphLock(options.transaction, (transaction) => super.updateMany({ ...options, transaction }));
  }
}
