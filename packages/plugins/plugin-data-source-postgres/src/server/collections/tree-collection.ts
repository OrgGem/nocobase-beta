/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Collection, CollectionContext, CollectionOptions, Model } from '@nocobase/database';
import { QueryTypes, Transaction } from 'sequelize';
import { PostgresAdjacencyListRepository } from './adjacency-list-repository';
import { PostgresValidationError } from '../utils/validation-error';

type TreeCollectionOptions = CollectionOptions & { postgresTree?: boolean | string; tree?: boolean | string };

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function normalizeTree(options: TreeCollectionOptions): TreeCollectionOptions {
  const result = { ...options, postgresTree: options.postgresTree || options.tree || true };
  delete result.tree;
  return result;
}

export class PostgresTreeCollection extends Collection {
  constructor(options: TreeCollectionOptions, context: CollectionContext) {
    super(normalizeTree(options), context);
    this.model.addHook('beforeSave', async (node: Model, hookOptions: { transaction?: Transaction }) => {
      if (!node.isNewRecord && !node.changed(this.treeForeignKey)) return;
      const primaryKey = this.model.primaryKeyAttribute;
      const nodeKey = node.get(primaryKey);
      const parent = node.get(this.treeForeignKey);
      if (parent === null || parent === undefined) return;
      if (!hookOptions.transaction) throw new PostgresValidationError('Tree parent changes require a transaction');
      if (nodeKey !== null && nodeKey !== undefined && String(parent) === String(nodeKey)) {
        throw new PostgresValidationError('Cycle detected in tree collection {{name}}', { name: this.name });
      }
      const modelTable = this.model.getTableName();
      const schema =
        typeof modelTable === 'object' && modelTable
          ? modelTable.schema || this.db.options.schema || 'public'
          : this.db.options.schema || 'public';
      const tableName =
        typeof modelTable === 'object' && modelTable ? modelTable.tableName : String(modelTable || this.name);
      await this.db.sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:tree, 0))', {
        replacements: { tree: `${schema}.${tableName}` },
        transaction: hookOptions.transaction,
      });
      const pk = quoteIdentifier(this.getField(primaryKey)?.columnName() || primaryKey);
      const fk = quoteIdentifier(this.getField(this.treeForeignKey)?.columnName() || this.treeForeignKey);
      const tableSql = `${quoteIdentifier(schema)}.${quoteIdentifier(tableName)}`;
      const hasNodeKey = nodeKey !== null && nodeKey !== undefined;
      const rows = await this.db.sequelize.query<{ hasCycle: boolean }>(
        `WITH RECURSIVE ancestors AS (
           SELECT t.${pk} AS id, t.${fk} AS "parentId", ARRAY[t.${pk}] AS path, FALSE AS is_cycle
           FROM ${tableSql} t
           WHERE t.${pk} = :parent
           UNION ALL
           SELECT p.${pk} AS id, p.${fk} AS "parentId", ancestors.path || p.${pk}, p.${pk} = ANY(ancestors.path) AS is_cycle
           FROM ${tableSql} p
           JOIN ancestors ON p.${pk} = ancestors."parentId"
           WHERE NOT ancestors.is_cycle
         )
         SELECT COALESCE(BOOL_OR(is_cycle${hasNodeKey ? ' OR id = :nodeKey' : ''}), FALSE) AS "hasCycle"
         FROM ancestors`,
        {
          replacements: hasNodeKey ? { parent, nodeKey } : { parent },
          type: QueryTypes.SELECT,
          transaction: hookOptions.transaction,
        },
      );
      if (rows[0]?.hasCycle) {
        throw new PostgresValidationError('Cycle detected in tree collection {{name}}', { name: this.name });
      }
    });
    this.model.addHook('beforeBulkCreate', (_nodes, hookOptions) => {
      hookOptions.individualHooks = true;
    });
    this.model.addHook('beforeBulkUpdate', (hookOptions) => {
      const { attributes } = hookOptions as typeof hookOptions & { attributes?: Record<string, unknown> };
      if (!hookOptions.individualHooks && Object.prototype.hasOwnProperty.call(attributes || {}, this.treeForeignKey)) {
        throw new PostgresValidationError('Bulk changes to a tree parent require individual hooks');
      }
    });
  }

  updateOptions(options: TreeCollectionOptions, mergeOptions?: unknown) {
    return super.updateOptions(normalizeTree(options), mergeOptions);
  }

  setRepository() {
    this.repository = new PostgresAdjacencyListRepository(this);
  }

  get treeForeignKey(): string {
    const foreignKey = this.treeParentField?.options.foreignKey;
    if (typeof foreignKey === 'string') return foreignKey;
    return typeof this.options.postgresTree === 'string' ? this.options.postgresTree : 'parentId';
  }
}
