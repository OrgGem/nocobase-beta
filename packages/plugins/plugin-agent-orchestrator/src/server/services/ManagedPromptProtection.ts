/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Database, Model } from '@nocobase/database';
import type { Transaction, WhereOptions } from 'sequelize';
import { read } from '../utils/record-utils';
import { isManagedPromptWrite } from './AgentGovernanceService';

type HookOptions = {
  transaction?: Transaction;
  where?: WhereOptions;
  attributes?: Record<string, unknown>;
};

export class ManagedPromptError extends Error {
  constructor() {
    super('This AI employee instruction is managed by an administrator.');
  }
}

/** Protect managed user/employee prompts on direct, bulk, and association writes. */
export function installManagedPromptProtection(db: Database) {
  const managed = async (userId: unknown, employeeUsername: unknown, transaction?: Transaction) => {
    if (userId == null || typeof employeeUsername !== 'string' || !employeeUsername) return false;
    return Boolean(
      await db.getRepository('agentGovernancePromptBindings').findOne({
        filter: { userId, employeeUsername },
        transaction,
      }),
    );
  };
  const checkRow = async (row: Model, options: HookOptions = {}) => {
    if (isManagedPromptWrite()) return;
    const previousUser = row.previous('userId');
    const previousEmployee = row.previous('aiEmployee');
    if (
      (await managed(
        previousUser ?? read(row, 'userId'),
        previousEmployee ?? read(row, 'aiEmployee'),
        options.transaction,
      )) ||
      (await managed(read(row, 'userId'), read(row, 'aiEmployee'), options.transaction))
    ) {
      throw new ManagedPromptError();
    }
  };
  const beforeUpdate = async (row: Model, options: HookOptions) => {
    if (row.changed('prompt') || row.changed('userId') || row.changed('aiEmployee')) await checkRow(row, options);
  };
  const beforeCreate = async (row: Model, options: HookOptions) => checkRow(row, options);
  const beforeDestroy = async (row: Model, options: HookOptions) => checkRow(row, options);
  const beforeBulk = async (options: HookOptions, onlyPromptChanges: boolean) => {
    if (isManagedPromptWrite()) return;
    if (
      onlyPromptChanges &&
      !['prompt', 'userId', 'aiEmployee'].some((key) =>
        Object.prototype.hasOwnProperty.call(options.attributes || {}, key),
      )
    )
      return;
    const model = db.getModel('usersAiEmployees');
    const rows = await model.findAll({ where: options.where, transaction: options.transaction });
    for (const row of rows) await checkRow(row, options);
  };
  const beforeBulkUpdate = async (options: HookOptions) => beforeBulk(options, true);
  const beforeBulkDestroy = async (options: HookOptions) => beforeBulk(options, false);
  const beforeBulkCreate = async (rows: Model[], options: HookOptions) => {
    for (const row of rows) await checkRow(row, options);
  };
  const handlers = [
    ['usersAiEmployees.beforeUpdate', beforeUpdate],
    ['usersAiEmployees.beforeCreate', beforeCreate],
    ['usersAiEmployees.beforeDestroy', beforeDestroy],
    ['usersAiEmployees.beforeBulkUpdate', beforeBulkUpdate],
    ['usersAiEmployees.beforeBulkDestroy', beforeBulkDestroy],
    ['usersAiEmployees.beforeBulkCreate', beforeBulkCreate],
  ] as const;
  for (const [event, handler] of handlers) db.on(event, handler);
  return () => {
    for (const [event, handler] of handlers) db.off(event, handler);
  };
}
