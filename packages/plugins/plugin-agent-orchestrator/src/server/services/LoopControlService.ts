import type { Database, Model, Transaction } from '@nocobase/database';

export type LoopControlState = 'running' | 'paused' | 'killed';

export type LoopControlSnapshot = {
  id: number;
  acceptNewRuns: boolean;
  state: LoopControlState;
  reason: string;
  globalMaxConcurrency: number;
  dailyMaxTokens: number | null;
  dailyMaxCost: number | null;
};

function read(record: Model | Record<string, unknown>, key: string) {
  const model = record as Model & { get?: (name: string) => unknown };
  return typeof model.get === 'function' ? model.get(key) : (record as Record<string, unknown>)[key];
}

function optionalLimit(value: unknown, label: string) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} is invalid.`);
  return parsed;
}

function snapshot(record: Model | Record<string, unknown>): LoopControlSnapshot {
  const id = Number(read(record, 'id'));
  const state = read(record, 'state');
  const maxConcurrency = Number(read(record, 'globalMaxConcurrency'));
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Global Loop Control settings have an invalid identifier.');
  if (state !== 'running' && state !== 'paused' && state !== 'killed') {
    throw new Error('Global Loop Control state is invalid.');
  }
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency <= 0) {
    throw new Error('Global Loop Control concurrency is invalid.');
  }
  return {
    id,
    acceptNewRuns: read(record, 'acceptNewRuns') === true,
    state,
    reason: typeof read(record, 'reason') === 'string' ? String(read(record, 'reason')) : '',
    globalMaxConcurrency: maxConcurrency,
    dailyMaxTokens: optionalLimit(read(record, 'dailyMaxTokens'), 'Global daily token limit'),
    dailyMaxCost: optionalLimit(read(record, 'dailyMaxCost'), 'Global daily cost limit'),
  };
}

export class LoopControlService {
  constructor(private readonly database: Database) {}

  async get(transaction?: Transaction) {
    const repository = this.database.getRepository('agentLoopControlSettings');
    let record = await repository.findOne({ filter: { key: 'global' }, transaction });
    if (!record) {
      record = await repository.create({
        values: {
          key: 'global',
          acceptNewRuns: true,
          state: 'running',
          globalMaxConcurrency: 5,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        transaction,
      });
    }
    return snapshot(record);
  }

  async getForUpdate(transaction: Transaction) {
    const repository = this.database.getRepository('agentLoopControlSettings');
    const record = await repository.findOne({
      filter: { key: 'global' },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!record) throw new Error('Global Loop Control settings were not found.');
    return snapshot(record);
  }

  async assertCanEnqueue(transaction?: Transaction) {
    const control = await this.get(transaction);
    if (!control.acceptNewRuns || control.state !== 'running') {
      throw new Error(control.reason || `Loop Control Plane is ${control.state}; new runs are disabled.`);
    }
    return control;
  }

  async assertCanExecute(transaction?: Transaction) {
    const control = await this.get(transaction);
    if (control.state !== 'running') {
      throw new Error(control.reason || `Loop Control Plane is ${control.state}.`);
    }
    return control;
  }

  async update(input: { state: LoopControlState; acceptNewRuns: boolean; reason: string; changedById?: number }) {
    return this.database.sequelize.transaction(async (transaction) => {
      const repository = this.database.getRepository('agentLoopControlSettings');
      const current = await this.get(transaction);
      const record = await repository.findOne({
        filterByTk: current.id,
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!record) throw new Error('Global Loop Control settings were not found.');
      await repository.update({
        filterByTk: current.id,
        values: {
          state: input.state,
          acceptNewRuns: input.acceptNewRuns,
          reason: input.reason,
          changedById: input.changedById || null,
          changedAt: new Date(),
        },
        transaction,
      });
      const updated = await repository.findOne({ filterByTk: current.id, transaction });
      if (!updated) throw new Error('Global Loop Control settings were not found after update.');
      return snapshot(updated);
    });
  }
}
