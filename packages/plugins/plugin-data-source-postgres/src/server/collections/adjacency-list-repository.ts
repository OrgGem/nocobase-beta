/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { CountOptions, FindAndCountOptions, FindOptions, Model, Repository } from '@nocobase/database';
import { QueryTypes, Transaction } from 'sequelize';
import { PostgresTreeCollection } from './tree-collection';
import { PostgresValidationError } from '../utils/validation-error';

type TreeOptions = FindOptions & { tree?: boolean; addIndex?: boolean };
type TreeNode = Model & { _options?: { includeNames?: string[] } };
type NodeLinkRow = { id: unknown; parentId: unknown; hasCycle: boolean };

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function hasValidFilter(condition: unknown): boolean {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
    return false;
  }
  const record = condition as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== '$and' && key !== '$or' && record[key] !== undefined)) {
    return true;
  }
  const groups = [record.$and, record.$or].filter(Boolean);
  if (!groups.length) return false;
  return groups.some((group) =>
    Array.isArray(group) ? group.some((item) => hasValidFilter(item)) : hasValidFilter(group),
  );
}

export class PostgresAdjacencyListRepository extends Repository {
  declare collection: PostgresTreeCollection;

  private getTreeMeta() {
    const primaryKeys = this.collection.model.primaryKeyAttributes;
    if (primaryKeys.length !== 1) throw new PostgresValidationError('A tree collection requires one primary key');
    const primaryKey = primaryKeys[0];
    const foreignKey = this.collection.treeForeignKey;
    const pkCol = this.collection.getField(primaryKey)?.columnName() || primaryKey;
    const fkCol = this.collection.getField(foreignKey)?.columnName() || foreignKey;
    const modelTable = this.collection.model.getTableName();
    const schema =
      typeof modelTable === 'object' && modelTable
        ? modelTable.schema || this.collection.db.options.schema || 'public'
        : this.collection.db.options.schema || 'public';
    const tableName =
      typeof modelTable === 'object' && modelTable ? modelTable.tableName : String(modelTable || this.collection.name);
    const tableSql = `${quoteIdentifier(schema)}.${quoteIdentifier(tableName)}`;
    return { primaryKey, foreignKey, pkCol, fkCol, tableSql };
  }

  private withRequiredTreeFields(options: TreeOptions, primaryKey: string, foreignKey: string): Partial<TreeOptions> {
    const result: Partial<TreeOptions> = {};
    if (Array.isArray(options.fields)) {
      result.fields = [...new Set([...options.fields, primaryKey, foreignKey])];
    }
    if (Array.isArray(options.except)) {
      result.except = options.except.filter((field) => field !== primaryKey && field !== foreignKey);
    }
    return result;
  }

  private buildRootOrderSql(sort: unknown, pkCol: string): string {
    const items = Array.isArray(sort) ? sort : typeof sort === 'string' ? [sort] : [];
    const clauses: string[] = [];
    for (const item of items) {
      if (typeof item !== 'string' || !item.trim()) continue;
      const desc = item.startsWith('-');
      const fieldName = desc ? item.slice(1) : item;
      const field = this.collection.getField(fieldName);
      if (field && !field.isRelationField() && field.dataType) {
        clauses.push(`t.${quoteIdentifier(field.columnName())} ${desc ? 'DESC' : 'ASC'}`);
      }
    }
    const pkOrder = `t.${quoteIdentifier(pkCol)} ASC`;
    if (!clauses.some((clause) => clause.startsWith(`t.${quoteIdentifier(pkCol)} `))) {
      clauses.push(pkOrder);
    }
    return clauses.join(', ');
  }

  private async fetchDownwardSubtree(
    tableSql: string,
    pkCol: string,
    fkCol: string,
    seedIds: unknown[],
    transaction?: Transaction,
  ): Promise<NodeLinkRow[]> {
    if (!seedIds.length) return [];
    const pk = quoteIdentifier(pkCol);
    const fk = quoteIdentifier(fkCol);
    const rows = await this.database.sequelize.query<NodeLinkRow>(
      `WITH RECURSIVE tree AS (
         SELECT t.${pk} AS id, t.${fk} AS "parentId", ARRAY[t.${pk}] AS path, FALSE AS is_cycle
         FROM ${tableSql} t
         WHERE t.${pk} IN (:seedIds)
         UNION ALL
         SELECT c.${pk} AS id, c.${fk} AS "parentId", tree.path || c.${pk}, c.${pk} = ANY(tree.path)
         FROM ${tableSql} c
         JOIN tree ON c.${fk} = tree.id
         WHERE NOT tree.is_cycle
       )
       SELECT id, "parentId", BOOL_OR(is_cycle) AS "hasCycle"
       FROM tree
       GROUP BY id, "parentId"`,
      { replacements: { seedIds }, type: QueryTypes.SELECT, transaction },
    );
    if (rows.some((row) => row.hasCycle)) {
      throw new PostgresValidationError('Cycle detected in tree collection {{name}}', { name: this.collection.name });
    }
    return rows;
  }

  private assembleTree(
    nodes: TreeNode[],
    rootOrder: string[],
    primaryKey: string,
    foreignKey: string,
    addIndex: boolean,
  ): Model[] {
    const nodesById = new Map(nodes.map((node) => [String(node.get(primaryKey)), node]));
    const children = new Map<string, TreeNode[]>();
    const rootsById = new Map<string, TreeNode>();
    for (const node of nodes) {
      const idKey = String(node.get(primaryKey));
      const parent = node.get(foreignKey);
      if (parent === null || parent === undefined || !nodesById.has(String(parent))) {
        rootsById.set(idKey, node);
      } else {
        const parentKey = String(parent);
        const siblings = children.get(parentKey) || [];
        siblings.push(node);
        children.set(parentKey, siblings);
      }
    }

    const roots: TreeNode[] = [];
    for (const idKey of rootOrder) {
      const root = rootsById.get(idKey);
      if (root) {
        roots.push(root);
        rootsById.delete(idKey);
      }
    }
    for (const remaining of rootsById.values()) {
      roots.push(remaining);
    }

    const childrenKey = this.collection.treeChildrenField?.name || 'children';
    const visited = new Set<string>();
    const attachChildren = (node: TreeNode, index: string) => {
      const key = String(node.get(primaryKey));
      if (visited.has(key)) {
        throw new PostgresValidationError('Cycle detected in tree collection {{name}}', { name: this.collection.name });
      }
      visited.add(key);
      const childNodes = children.get(key) || [];
      if (addIndex) node.setDataValue('__index', index);
      if (childNodes.length) {
        node._options = node._options || {};
        node._options.includeNames = node._options.includeNames || [];
        if (!node._options.includeNames.includes(childrenKey)) node._options.includeNames.push(childrenKey);
        node.setDataValue(childrenKey, childNodes);
        childNodes.forEach((child, childIndex) => attachChildren(child, `${index}.${childrenKey}.${childIndex}`));
      }
    };
    roots.forEach((node, index) => attachChildren(node, String(index)));
    if (visited.size !== nodes.length) {
      throw new PostgresValidationError('Cycle detected in tree collection {{name}}', { name: this.collection.name });
    }
    return roots;
  }

  private async countUnfilteredRoots(
    tableSql: string,
    pkCol: string,
    fkCol: string,
    transaction?: Transaction,
  ): Promise<number> {
    const pk = quoteIdentifier(pkCol);
    const fk = quoteIdentifier(fkCol);
    const rows = await this.database.sequelize.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM ${tableSql} t
       WHERE t.${fk} IS NULL OR NOT EXISTS (SELECT 1 FROM ${tableSql} p WHERE p.${pk} = t.${fk})`,
      { type: QueryTypes.SELECT, transaction },
    );
    return Number(rows[0]?.count || 0);
  }

  private async findUnfilteredPaged(options: TreeOptions): Promise<Model[]> {
    const { primaryKey, foreignKey, pkCol, fkCol, tableSql } = this.getTreeMeta();
    const limit = typeof options.limit === 'number' ? options.limit : undefined;
    const offset = typeof options.offset === 'number' && options.offset > 0 ? options.offset : 0;
    if (limit === 0) return [];

    const pk = quoteIdentifier(pkCol);
    const fk = quoteIdentifier(fkCol);
    const orderBy = this.buildRootOrderSql(options.sort, pkCol);
    const replacements: Record<string, unknown> = {};
    let paginationSql = '';
    if (limit !== undefined) {
      paginationSql += ' LIMIT :limit';
      replacements.limit = limit;
    }
    if (offset > 0) {
      paginationSql += ' OFFSET :offset';
      replacements.offset = offset;
    }

    const rootRows = await this.database.sequelize.query<{ id: unknown }>(
      `SELECT t.${pk} AS id
       FROM ${tableSql} t
       WHERE t.${fk} IS NULL OR NOT EXISTS (SELECT 1 FROM ${tableSql} p WHERE p.${pk} = t.${fk})
       ORDER BY ${orderBy}${paginationSql}`,
      { replacements, type: QueryTypes.SELECT, transaction: options.transaction },
    );
    const rootIds = rootRows.map((row) => row.id);
    if (!rootIds.length) return [];

    const subtreeRows = await this.fetchDownwardSubtree(tableSql, pkCol, fkCol, rootIds, options.transaction);
    const collectedIds = subtreeRows.map((row) => row.id);
    const nodes = (await super.find({
      ...options,
      ...this.withRequiredTreeFields(options, primaryKey, foreignKey),
      tree: false,
      filter: { [primaryKey]: collectedIds },
      filterByTk: undefined,
      limit: undefined,
      offset: undefined,
    })) as TreeNode[];

    return this.assembleTree(nodes, rootIds.map(String), primaryKey, foreignKey, options.addIndex !== false);
  }

  private async resolveFilteredTree(options: TreeOptions): Promise<{
    rootIds: unknown[];
    subtreeRows: NodeLinkRow[];
    primaryKey: string;
    foreignKey: string;
  }> {
    const { primaryKey, foreignKey, pkCol, fkCol, tableSql } = this.getTreeMeta();
    const matchedNodes = (await super.find({
      ...options,
      fields: [primaryKey, foreignKey],
      except: undefined,
      appends: undefined,
      tree: false,
      limit: undefined,
      offset: undefined,
    })) as TreeNode[];
    if (!matchedNodes.length) {
      return { rootIds: [], subtreeRows: [], primaryKey, foreignKey };
    }

    const seedIds = matchedNodes.map((node) => node.get(primaryKey));
    const subtreeRows = await this.fetchDownwardSubtree(tableSql, pkCol, fkCol, seedIds, options.transaction);
    const visibleIds = new Set(subtreeRows.map((row) => String(row.id)));
    const seenRoots = new Set<string>();
    const rootIds: unknown[] = [];

    for (const node of matchedNodes) {
      const id = node.get(primaryKey);
      const idKey = String(id);
      if (seenRoots.has(idKey)) continue;
      const parent = node.get(foreignKey);
      if (parent === null || parent === undefined || !visibleIds.has(String(parent))) {
        seenRoots.add(idKey);
        rootIds.push(id);
      }
    }

    return { rootIds, subtreeRows, primaryKey, foreignKey };
  }

  private async loadFilteredPage(
    options: TreeOptions,
    resolved: { rootIds: unknown[]; subtreeRows: NodeLinkRow[]; primaryKey: string; foreignKey: string },
  ): Promise<Model[]> {
    const offset = typeof options.offset === 'number' && options.offset > 0 ? options.offset : 0;
    const limit = typeof options.limit === 'number' ? options.limit : undefined;
    const pagedRootIds = resolved.rootIds.slice(offset, limit === undefined ? undefined : offset + limit);
    if (!pagedRootIds.length) return [];

    const childrenByParent = new Map<string, unknown[]>();
    for (const row of resolved.subtreeRows) {
      if (row.parentId !== null && row.parentId !== undefined) {
        const parentKey = String(row.parentId);
        const list = childrenByParent.get(parentKey) || [];
        list.push(row.id);
        childrenByParent.set(parentKey, list);
      }
    }

    const pageIds: unknown[] = [];
    const queued = new Set<string>();
    const queue = [...pagedRootIds];
    while (queue.length) {
      const current = queue.shift();
      const key = String(current);
      if (queued.has(key)) continue;
      queued.add(key);
      pageIds.push(current);
      const kids = childrenByParent.get(key);
      if (kids) queue.push(...kids);
    }

    const nodes = (await super.find({
      ...options,
      ...this.withRequiredTreeFields(options, resolved.primaryKey, resolved.foreignKey),
      tree: false,
      filter: { [resolved.primaryKey]: pageIds },
      filterByTk: undefined,
      limit: undefined,
      offset: undefined,
    })) as TreeNode[];

    return this.assembleTree(
      nodes,
      pagedRootIds.map(String),
      resolved.primaryKey,
      resolved.foreignKey,
      options.addIndex !== false,
    );
  }

  private hasWhereClause(where: unknown): boolean {
    if (typeof where === 'string') return where.trim().length > 0;
    if (!where || typeof where !== 'object') return false;
    return Reflect.ownKeys(where).length > 0;
  }

  private isFiltered(options: { filter?: unknown; filterByTk?: unknown; where?: unknown }): boolean {
    return options.filterByTk !== undefined || hasValidFilter(options.filter) || this.hasWhereClause(options.where);
  }

  async find(options: TreeOptions = {}): Promise<Model[]> {
    if (!options.tree || options.raw) return super.find(options);
    if (!this.isFiltered(options)) {
      return this.findUnfilteredPaged(options);
    }
    const resolved = await this.resolveFilteredTree(options);
    return this.loadFilteredPage(options, resolved);
  }

  async count(options: CountOptions & { tree?: boolean; raw?: boolean } = {}): Promise<number> {
    if (!options.tree || options.raw) return super.count(options);
    if (!this.isFiltered(options)) {
      const { pkCol, fkCol, tableSql } = this.getTreeMeta();
      return this.countUnfilteredRoots(tableSql, pkCol, fkCol, options.transaction);
    }
    const resolved = await this.resolveFilteredTree(options as TreeOptions);
    return resolved.rootIds.length;
  }

  async findAndCount(
    options: FindAndCountOptions & { tree?: boolean; addIndex?: boolean } = {},
  ): Promise<[Model[], number]> {
    if (!options.tree || options.raw) return super.findAndCount(options);
    if (!this.isFiltered(options)) {
      const { pkCol, fkCol, tableSql } = this.getTreeMeta();
      const total = await this.countUnfilteredRoots(tableSql, pkCol, fkCol, options.transaction);
      if (!total) return [[], 0];
      const rows = await this.findUnfilteredPaged(options);
      return [rows, total];
    }
    const resolved = await this.resolveFilteredTree(options);
    const rows = await this.loadFilteredPage(options, resolved);
    return [rows, resolved.rootIds.length];
  }
}
