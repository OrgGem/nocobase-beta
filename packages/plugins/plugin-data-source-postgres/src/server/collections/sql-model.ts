/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Model } from '@nocobase/database';
import { isEmpty } from 'lodash';
import { QueryTypes, Transaction } from 'sequelize';
import type { GroupOption, Order, ProjectionAlias, WhereOptions } from 'sequelize';
import { PostgresValidationError } from '../utils/validation-error';

type SelectOptions = {
  attributes?: (string | ProjectionAlias)[];
  where?: WhereOptions | string;
  order?: Order;
  group?: GroupOption | string;
  limit?: number;
  offset?: number;
  transaction?: Transaction | null;
  [key: string]: unknown;
};

type SqlGenerator = {
  escapeAttributes(attributes: SelectOptions['attributes'], options: { model: typeof SQLModel }): string[] | undefined;
  getWhereConditions(
    where: SelectOptions['where'],
    name: string,
    model: typeof SQLModel,
    options: SelectOptions,
  ): string;
  aliasGrouping(value: unknown, model: typeof SQLModel, name: string, options: SelectOptions): string;
  getQueryOrders(options: SelectOptions, model: typeof SQLModel, subQuery: boolean): { mainQueryOrder: string[] };
  addLimitAndOffset(options: SelectOptions, model: typeof SQLModel): string;
  getAliasToken(): string;
  quoteIdentifier(value: string): string;
};

// Mirrors the host SQL collection's query generator, retaining its filter, order and pagination options.
function selectQuery(this: SqlGenerator, _tableName: string, options: SelectOptions, model: typeof SQLModel): string {
  const queryOptions = options || {};
  if (isEmpty(queryOptions)) return `${model.sql};`;

  let attributes = queryOptions.attributes?.slice();
  if (attributes) {
    const fields = Array.from(model.collection.fields.keys());
    attributes = attributes.filter(
      (attribute) => attribute === '*' || typeof attribute !== 'string' || fields.includes(attribute),
    );
  }
  const escaped = this.escapeAttributes(attributes, { model });
  const selected = escaped && escaped.length > 0 ? escaped : ['*'];
  const clauses: string[] = [];
  if (Object.prototype.hasOwnProperty.call(queryOptions, 'where')) {
    const where = this.getWhereConditions(queryOptions.where, model.name, model, queryOptions);
    if (where) clauses.push(` WHERE ${where}`);
  }
  if (queryOptions.group) {
    const groups = Array.isArray(queryOptions.group) ? queryOptions.group : [queryOptions.group];
    clauses.push(
      ` GROUP BY ${groups.map((value) => this.aliasGrouping(value, model, model.name, queryOptions)).join(', ')}`,
    );
  }
  if (queryOptions.order) {
    const orders = this.getQueryOrders(queryOptions, model, false).mainQueryOrder;
    if (orders.length) clauses.push(` ORDER BY ${orders.join(', ')}`);
  }
  const limit = this.addLimitAndOffset(queryOptions, model);
  if (limit) clauses.push(limit);
  return `SELECT ${selected.join(', ')} FROM (${model.sql}) ${this.getAliasToken()} ${this.quoteIdentifier(
    model.name,
  )}${clauses.join('')};`;
}

export class SQLModel extends Model {
  static sql: string;

  static get queryInterface() {
    const queryInterface = this.sequelize.getQueryInterface();
    const nativeGenerator = (
      queryInterface as unknown as { queryGenerator: { quoteIdentifier(value: string): string } }
    ).queryGenerator;
    const generator = new Proxy(nativeGenerator, {
      get(target, key, receiver) {
        return key === 'selectQuery' ? selectQuery : Reflect.get(target, key, receiver);
      },
    });

    return new Proxy(queryInterface, {
      get: (target, key, receiver) => {
        if (key === 'queryGenerator') return generator;
        if (key !== 'select' && key !== 'rawSelect') return Reflect.get(target, key, receiver);

        return async (...args: unknown[]) => {
          const optionsIndex = key === 'select' ? 2 : 1;
          const options = (args[optionsIndex] || {}) as SelectOptions;
          const schema = this.database.options.schema || 'public';
          const quotedSchema = nativeGenerator.quoteIdentifier(schema);
          if (options.transaction) {
            const transaction = options.transaction;
            const [settings] = await this.sequelize.query<{ readOnly: string; searchPath: string; scs: string }>(
              `SELECT current_setting('transaction_read_only') AS "readOnly", current_setting('search_path') AS "searchPath", current_setting('standard_conforming_strings') AS scs`,
              { type: QueryTypes.SELECT, transaction },
            );
            if (settings.readOnly !== 'on')
              throw new PostgresValidationError('SQL collection queries require a read-only transaction');
            await this.sequelize.query(`SELECT set_config('standard_conforming_strings', 'on', true)`, { transaction });
            await this.sequelize.query(`SELECT set_config('search_path', :path, true)`, {
              replacements: { path: quotedSchema },
              transaction,
            });
            let result: unknown;
            try {
              result = await Reflect.apply(Reflect.get(target, key), receiver, args);
            } catch (error) {
              try {
                await this.sequelize.query(`SELECT set_config('search_path', :path, true)`, {
                  replacements: { path: settings.searchPath },
                  transaction,
                });
                await this.sequelize.query(`SELECT set_config('standard_conforming_strings', :scs, true)`, {
                  replacements: { scs: settings.scs },
                  transaction,
                });
              } catch {
                // A failed SQL statement can abort the transaction before session settings can be restored.
              }
              throw error;
            }
            await this.sequelize.query(`SELECT set_config('search_path', :path, true)`, {
              replacements: { path: settings.searchPath },
              transaction,
            });
            await this.sequelize.query(`SELECT set_config('standard_conforming_strings', :scs, true)`, {
              replacements: { scs: settings.scs },
              transaction,
            });
            return result;
          }
          return this.sequelize.transaction(async (transaction) => {
            await this.sequelize.query('SET TRANSACTION READ ONLY', { transaction });
            await this.sequelize.query('SET LOCAL standard_conforming_strings = on', { transaction });
            await this.sequelize.query(`SET LOCAL search_path TO ${quotedSchema}`, { transaction });
            args[optionsIndex] = { ...options, transaction };
            return Reflect.apply(Reflect.get(target, key), receiver, args);
          });
        };
      },
    });
  }

  static async sync<M extends Model>(): Promise<M> {
    return this as unknown as M;
  }
}
