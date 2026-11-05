/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { ACL } from '@nocobase/acl';
import { describe, expect, it, vi } from 'vitest';
import { cursorPaginationAction } from '../resources/database-plus-manager';
import { listPaginationOverride } from '../plugin';

function fixture() {
  const acl = new ACL();
  acl.define({ role: 'reader', actions: { 'orders:list': { fields: ['id'], filter: { ownerId: 7 } } } });
  const repo = { find: vi.fn(async () => []) };
  const ctx = {
    app: { acl },
    state: { currentRoles: ['reader'] },
    action: {
      resourceName: 'orders',
      sourceId: undefined,
      params: { paginationMode: 'cursor', collection: 'secret', sort: ['id'] },
    },
    db: { getRepository: vi.fn(() => repo) },
    getCurrentRepository: vi.fn(() => repo),
    throw: (status: number) => {
      throw Object.assign(new Error('denied'), { status });
    },
  };
  return { ctx, repo };
}

it('uses the current authorized datasource repository despite query substitution', async () => {
  const { ctx, repo } = fixture();
  await cursorPaginationAction(ctx, vi.fn());
  expect(ctx.getCurrentRepository).toHaveBeenCalled();
  expect(ctx.db.getRepository).not.toHaveBeenCalled();
  expect(repo.find).toHaveBeenCalled();
});

it('requires data ACL in addition to standalone cursor endpoint permission', async () => {
  const { ctx, repo } = fixture();
  ctx.action.resourceName = 'databasePlusManager';
  await expect(cursorPaginationAction(ctx, vi.fn())).rejects.toMatchObject({ status: 403 });
  expect(repo.find).not.toHaveBeenCalled();
  ctx.action.params.collection = 'orders';
  await cursorPaginationAction(ctx, vi.fn());
  expect(repo.find).toHaveBeenCalledWith(expect.objectContaining({ fields: ['id'], filter: { ownerId: 7 } }));
});

it('leaves association pagination to the built-in action', async () => {
  const { ctx, repo } = fixture();
  ctx.action.resourceName = 'customers.orders';
  const next = vi.fn();
  await listPaginationOverride(ctx, next);
  expect(next).toHaveBeenCalledOnce();
  expect(repo.find).not.toHaveBeenCalled();
});
