/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Collection } from '@nocobase/database';
import type { Transaction } from 'sequelize';
import { describe, expect, it, vi } from 'vitest';
import {
  buildArrayForeignKeyField,
  fieldReferencesColumn,
  getRelationLockTables,
  syncFieldAction,
} from '../hooks/field-hooks';
import type { PostgresCollectionManager } from '../postgres-collection-manager';

describe('field-hooks', () => {
  it('detects references by either logical field name or physical column name', () => {
    const relation = {
      type: 'belongsTo',
      target: 'orders',
      foreignKey: 'order_code',
      targetKey: 'order_code',
    };

    expect(fieldReferencesColumn(relation, 'order_items', 'orders', ['orderCode', 'order_code'])).toBe(true);
    expect(fieldReferencesColumn(relation, 'order_items', 'orders', ['orderCode'])).toBe(false);
  });

  it('writes derived belongsTo defaults back onto input so downstream beforeCreate succeeds', async () => {
    const ensureForeignKey = vi.fn().mockResolvedValue(undefined);
    const manager = {
      getCollection: vi.fn().mockReturnValue({
        name: 'order_items',
        getField: vi.fn().mockReturnValue(undefined),
      } as unknown as Collection),
      ensureForeignKey,
    } as unknown as PostgresCollectionManager;
    const input: Record<string, unknown> = {
      name: 'order',
      interface: 'm2o',
      target: 'orders',
    };

    await syncFieldAction(manager, 'create', 'order_items', undefined, input, {} as Transaction);

    expect(ensureForeignKey).toHaveBeenCalledWith(
      'order_items',
      expect.objectContaining({
        target: 'orders',
        targetKey: 'id',
        foreignKey: 'orderId',
      }),
      expect.anything(),
    );
    expect(input).toMatchObject({
      type: 'belongsTo',
      target: 'orders',
      targetKey: 'id',
      foreignKey: 'orderId',
    });
  });

  it('rejects primary-key/auto-increment changes and relation-to-column type flips', async () => {
    const existingField = {
      name: 'code',
      options: { name: 'code', type: 'string', primaryKey: false, autoIncrement: false },
      isRelationField: () => false,
      columnName: () => 'code',
    };
    const manager = {
      getCollection: vi.fn().mockReturnValue({
        name: 'orders',
        getField: vi.fn().mockReturnValue(existingField),
      } as unknown as Collection),
    } as unknown as PostgresCollectionManager;

    await expect(
      syncFieldAction(manager, 'update', 'orders', 'code', { primaryKey: true }, {} as Transaction),
    ).rejects.toThrow('Field code cannot change generated-id or primary-key settings');

    await expect(
      syncFieldAction(manager, 'update', 'orders', 'code', { type: 'belongsTo' }, {} as Transaction),
    ).rejects.toThrow('Field code cannot be changed between a relation and a physical column');
  });

  it('ensures physical foreign keys for hasMany/hasOne, join tables for belongsToMany, and array columns for belongsToArray', async () => {
    const ensureForeignKey = vi.fn().mockResolvedValue(undefined);
    const ensureJoinTable = vi.fn().mockResolvedValue(undefined);
    const ensureForeignKeyArray = vi.fn().mockResolvedValue(undefined);
    const collections: Record<string, Collection> = {
      orders: {
        name: 'orders',
        options: { tableName: 'orders' },
        model: { primaryKeyAttribute: 'id' },
        getField: vi.fn().mockReturnValue(undefined),
      } as unknown as Collection,
      order_items: {
        name: 'order_items',
        options: { tableName: 'order_items' },
        model: { primaryKeyAttribute: 'id' },
        getField: vi.fn().mockReturnValue(undefined),
      } as unknown as Collection,
      tags: {
        name: 'tags',
        options: { tableName: 'tags' },
        model: { primaryKeyAttribute: 'id' },
        getField: vi.fn().mockReturnValue(undefined),
      } as unknown as Collection,
      order_view: {
        name: 'order_view',
        options: { tableName: 'order_view', view: true },
        model: { primaryKeyAttribute: 'id' },
        getField: vi.fn().mockReturnValue(undefined),
      } as unknown as Collection,
    };
    const manager = {
      db: { options: { schema: 'public' } },
      getCollection: vi.fn((name: string) => collections[name]),
      ensureForeignKey,
      ensureJoinTable,
      ensureForeignKeyArray,
    } as unknown as PostgresCollectionManager;

    const hasManyInput: Record<string, unknown> = { name: 'items', interface: 'o2m', target: 'order_items' };
    await syncFieldAction(manager, 'create', 'orders', undefined, hasManyInput, {} as Transaction);
    expect(ensureForeignKey).toHaveBeenCalledWith(
      'order_items',
      expect.objectContaining({ target: 'orders', targetKey: 'id', foreignKey: 'orderId' }),
      expect.anything(),
    );
    expect(hasManyInput).toMatchObject({
      type: 'hasMany',
      target: 'order_items',
      sourceKey: 'id',
      foreignKey: 'orderId',
    });

    const m2mInput: Record<string, unknown> = { name: 'tags', interface: 'm2m', target: 'tags' };
    await syncFieldAction(manager, 'create', 'orders', undefined, m2mInput, {} as Transaction);
    expect(ensureJoinTable).toHaveBeenCalledWith(
      'orders',
      expect.objectContaining({
        target: 'tags',
        through: 'ordersTags',
        foreignKey: 'orderId',
        otherKey: 'tagId',
        sourceKey: 'id',
        targetKey: 'id',
      }),
      expect.anything(),
    );
    expect(m2mInput).toMatchObject({
      type: 'belongsToMany',
      through: 'ordersTags',
      foreignKey: 'orderId',
      otherKey: 'tagId',
    });

    const arrayInput: Record<string, unknown> = { name: 'tagRefs', interface: 'm2m_array', target: 'tags' };
    await syncFieldAction(manager, 'create', 'orders', undefined, arrayInput, {} as Transaction);
    expect(ensureForeignKeyArray).toHaveBeenCalledWith(
      'orders',
      expect.objectContaining({ target: 'tags', targetKey: 'id', foreignKey: 'tagRefId' }),
      expect.anything(),
    );
    expect(arrayInput).toMatchObject({ type: 'belongsToArray', foreignKey: 'tagRefId', targetKey: 'id' });

    await expect(
      syncFieldAction(
        manager,
        'create',
        'orders',
        undefined,
        { name: 'v', interface: 'o2m', target: 'order_view' },
        {} as Transaction,
      ),
    ).rejects.toThrow('This collection is read-only');

    expect(getRelationLockTables(manager, 'orders', m2mInput)).toEqual([
      'public.orders',
      'public.ordersTags',
      'public.tags',
    ]);
  });

  it('passes replaceActions on relation updates and locks existing/new target and join tables on partial updates', async () => {
    const ensureForeignKey = vi.fn().mockResolvedValue(undefined);
    const ensureJoinTable = vi.fn().mockResolvedValue(undefined);
    const existingFields: Record<string, { name: string; options: Record<string, unknown> }> = {
      items: {
        name: 'items',
        options: { name: 'items', type: 'hasMany', target: 'order_items', foreignKey: 'orderId', sourceKey: 'id' },
      },
      tags: {
        name: 'tags',
        options: {
          name: 'tags',
          type: 'belongsToMany',
          target: 'tags',
          through: 'orders_tags',
          foreignKey: 'orderId',
          otherKey: 'tagId',
          sourceKey: 'id',
          targetKey: 'id',
        },
      },
    };
    const collections: Record<string, Collection> = {
      orders: {
        name: 'orders',
        options: { tableName: 'orders' },
        model: { primaryKeyAttribute: 'id' },
        getField: vi.fn((name: string) => existingFields[name]),
      } as unknown as Collection,
      order_items: {
        name: 'order_items',
        options: { tableName: 'order_items' },
        model: { primaryKeyAttribute: 'id' },
        getField: vi.fn().mockReturnValue(undefined),
      } as unknown as Collection,
      tags: {
        name: 'tags',
        options: { tableName: 'tags' },
        model: { primaryKeyAttribute: 'id' },
        getField: vi.fn().mockReturnValue(undefined),
      } as unknown as Collection,
    };
    const manager = {
      db: { options: { schema: 'public' } },
      getCollection: vi.fn((name: string) => collections[name]),
      ensureForeignKey,
      ensureJoinTable,
    } as unknown as PostgresCollectionManager;

    expect(getRelationLockTables(manager, 'orders', { onDelete: 'CASCADE' }, 'items')).toEqual([
      'public.order_items',
      'public.orders',
    ]);
    expect(getRelationLockTables(manager, 'orders', { name: 'tags', through: 'orders_tags_v2' })).toEqual([
      'public.orders',
      'public.orders_tags',
      'public.orders_tags_v2',
      'public.tags',
    ]);

    await syncFieldAction(manager, 'update', 'orders', 'items', { onDelete: 'CASCADE' }, {} as Transaction);
    expect(ensureForeignKey).toHaveBeenCalledWith(
      'order_items',
      expect.objectContaining({
        target: 'orders',
        foreignKey: 'orderId',
        targetKey: 'id',
        onDelete: 'CASCADE',
        replaceActions: true,
      }),
      expect.anything(),
    );

    await syncFieldAction(manager, 'update', 'orders', 'tags', { onDelete: 'RESTRICT' }, {} as Transaction);
    expect(ensureJoinTable).toHaveBeenCalledWith(
      'orders',
      expect.objectContaining({
        target: 'tags',
        through: 'orders_tags',
        onDelete: 'RESTRICT',
        replaceActions: true,
      }),
      expect.anything(),
    );
  });

  it('guards belongsToArray column references, blocks belongsTo targeting views, and builds companion array fields', async () => {
    const arrayRelation = {
      type: 'belongsToArray',
      target: 'tags',
      foreignKey: 'tagRefId',
      targetKey: 'code',
    };
    expect(fieldReferencesColumn(arrayRelation, 'orders', 'orders', ['tagRefId'])).toBe(true);
    expect(fieldReferencesColumn(arrayRelation, 'orders', 'tags', ['code'])).toBe(true);
    expect(fieldReferencesColumn(arrayRelation, 'orders', 'tags', ['id'])).toBe(false);

    const collections: Record<string, Collection> = {
      orders: {
        name: 'orders',
        options: { tableName: 'orders' },
        model: { primaryKeyAttribute: 'id' },
        getField: vi.fn().mockReturnValue(undefined),
      } as unknown as Collection,
      tags: {
        name: 'tags',
        options: { tableName: 'tags' },
        model: { primaryKeyAttribute: 'code' },
        getField: vi.fn((name: string) =>
          name === 'code' ? { name: 'code', options: { name: 'code', type: 'nanoid' } } : undefined,
        ),
      } as unknown as Collection,
      order_view: {
        name: 'order_view',
        options: { tableName: 'order_view', view: true },
        model: { primaryKeyAttribute: 'id' },
        getField: vi.fn().mockReturnValue(undefined),
      } as unknown as Collection,
    };
    const manager = {
      db: { options: { schema: 'public' } },
      getCollection: vi.fn((name: string) => collections[name]),
      ensureForeignKey: vi.fn().mockResolvedValue(undefined),
      ensureForeignKeyArray: vi.fn().mockResolvedValue(undefined),
    } as unknown as PostgresCollectionManager;

    await expect(
      syncFieldAction(
        manager,
        'create',
        'orders',
        undefined,
        { name: 'viewRef', interface: 'm2o', target: 'order_view' },
        {} as Transaction,
      ),
    ).rejects.toThrow('This collection is read-only');

    await expect(
      syncFieldAction(
        manager,
        'create',
        'orders',
        undefined,
        { name: 'tagRefId', interface: 'm2m_array', target: 'tags', foreignKey: 'tagRefId' },
        {} as Transaction,
      ),
    ).rejects.toThrow('Foreign key tagRefId cannot have the same name as relation field tagRefId');

    expect(
      buildArrayForeignKeyField(manager, 'orders', {
        name: 'tagRefs',
        type: 'belongsToArray',
        target: 'tags',
        targetKey: 'code',
        foreignKey: 'tagRefId',
      }),
    ).toMatchObject({
      name: 'tagRefId',
      field: 'tagRefId',
      type: 'set',
      dataType: 'array',
      elementType: 'string',
      interface: 'json',
      isForeignKey: true,
    });
  });
});
