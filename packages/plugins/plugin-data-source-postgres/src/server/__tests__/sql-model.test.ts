/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Database } from '@nocobase/database';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgresSQLCollection } from '../collections/sql-collection';
import { SQLModel } from '../collections/sql-model';

type SqlGeneratorStub = {
  selectQuery: (tableName: string, options: Record<string, unknown>, model: typeof SQLModel) => string;
};

describe('SQLModel selectQuery', () => {
  const db = new Database({
    dialect: 'postgres',
    host: '127.0.0.1',
    port: 5432,
    database: 'unused',
    username: 'unused',
    logging: false,
  });

  afterAll(async () => {
    await db.close();
  });

  db.collectionFactory.registerCollectionType(PostgresSQLCollection, {
    condition: (options) => Boolean(options.sql),
    async onSync() {},
    async onDump() {},
  });

  const collection = db.collection({
    name: 'order_summary',
    sql: 'SELECT id, name FROM orders;',
    fields: [
      { name: 'id', type: 'integer' },
      { name: 'name', type: 'string' },
    ],
  }) as PostgresSQLCollection;

  const model = collection.model as unknown as typeof SQLModel;
  const queryInterface = model.queryInterface as unknown as { queryGenerator: SqlGeneratorStub };

  it('selects matching attributes with where, order, limit, and offset', () => {
    const sql = queryInterface.queryGenerator.selectQuery(
      'order_summary',
      {
        attributes: ['id', 'unknown_col'],
        where: { id: 10 },
        order: [['id', 'DESC']],
        limit: 5,
        offset: 10,
      },
      model,
    );

    expect(sql).toContain('SELECT "id" FROM (SELECT id, name FROM orders)');
    expect(sql).toContain('WHERE "order_summary"."id" = 10');
    expect(sql).toContain('ORDER BY "order_summary"."id" DESC');
    expect(sql).toContain('LIMIT 5 OFFSET 10');
  });

  it('falls back to * when filtered attributes are empty so SELECT FROM syntax stays valid', () => {
    const sql = queryInterface.queryGenerator.selectQuery(
      'order_summary',
      {
        attributes: ['nonexistent_column'],
        where: { id: 1 },
      },
      model,
    );

    expect(sql).toContain('SELECT * FROM (SELECT id, name FROM orders)');
    expect(sql).not.toMatch(/SELECT\s+FROM/);
  });

  it('updates model SQL in place on updateOptions without losing field attributes or filterTargetKey', () => {
    const updatable = db.collection({
      name: 'updatable_summary',
      sql: 'SELECT id, name FROM orders;',
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'name', type: 'string' },
      ],
    }) as PostgresSQLCollection;

    updatable.updateOptions({
      name: 'updatable_summary',
      sql: 'SELECT id, name FROM updated_orders;',
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'name', type: 'string' },
      ],
    });

    expect(updatable.model.getAttributes().id).toBeDefined();
    expect(updatable.filterTargetKey).toBe('id');
    const updatedQuery = (
      updatable.model.queryInterface as unknown as { queryGenerator: SqlGeneratorStub }
    ).queryGenerator.selectQuery(
      'updatable_summary',
      { attributes: ['id'], where: { id: 42 } },
      updatable.model as unknown as typeof SQLModel,
    );
    expect(updatedQuery).toContain('SELECT "id" FROM (SELECT id, name FROM updated_orders)');
    expect(updatedQuery).toContain('WHERE "updatable_summary"."id" = 42');
  });
});
