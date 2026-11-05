/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { ACL } from '@nocobase/acl';
import type { Context } from '@nocobase/actions';
import { dataWrapping } from '../../../../../core/server/src/middlewares/data-wrapping';
import { describe, expect, it, vi } from 'vitest';
import { crossJoinQuery } from '../actions/cross-join-query';

function fixture(role = 'reader') {
  const acl = new ACL();
  acl.define({ role: 'reader', actions: { 'orders:list': { fields: ['id', 'ownerId'], filter: { ownerId: 7 } } } });
  acl.define({ role: 'root' });
  const externalAcl = new ACL();
  externalAcl.define({
    role: 'reader',
    actions: { 'details:list': { fields: ['id', 'label'], filter: { visible: true } } },
  });
  const repo = { find: vi.fn(async () => [{ id: 1, ownerId: 7 }]), count: vi.fn(async () => 1) };
  const joinRepo = { find: vi.fn(async () => [{ id: 1, label: 'Visible' }]) };
  const sources = {
    main: { acl, collectionManager: { getRepository: () => repo } },
    external: { acl: externalAcl, collectionManager: { getRepository: () => joinRepo } },
  };
  const config = {
    primarySource: { dataSource: 'main', collection: 'orders', filter: { id: 1 } },
    joins: [{ dataSource: 'external', collection: 'details', joinType: 'left', leftField: 'id', rightField: 'id' }],
    columns: [],
  };
  const ctx = {
    app: { dataSourceManager: { get: (name: string) => sources[name] } },
    state: { currentRoles: [role], currentUser: { id: 7 } },
    action: { params: { config, page: 1, pageSize: 20 } },
    throw: (status: number) => {
      throw Object.assign(new Error('denied'), { status });
    },
  } as unknown as Context;
  return { ctx, config, repo, joinRepo };
}

describe('cross join data permissions and response', () => {
  it('applies filters and fields on every datasource and wraps the rows exactly once', async () => {
    const { ctx, repo, joinRepo } = fixture();
    await dataWrapping()(ctx, () => crossJoinQuery(ctx, async () => undefined));
    expect(repo.find).toHaveBeenCalledWith(
      expect.objectContaining({ fields: ['id', 'ownerId'], filter: { $and: [{ id: 1 }, { ownerId: 7 }] } }),
    );
    expect(repo.count).toHaveBeenCalledWith(expect.objectContaining({ filter: { $and: [{ id: 1 }, { ownerId: 7 }] } }));
    expect(joinRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        fields: ['id', 'label'],
        filter: { $and: [{ visible: true }, { id: { $in: ['1'] } }] },
      }),
    );
    expect(ctx.body).toEqual({
      data: [{ 'primary.id': 1, 'primary.ownerId': 7, 'join0.id': 1, 'join0.label': 'Visible' }],
      meta: { page: 1, pageSize: 20, count: 1 },
    });
  });

  it('denies ungranted roles before reading either repository', async () => {
    const { ctx, repo, joinRepo } = fixture('member');
    await expect(crossJoinQuery(ctx, vi.fn())).rejects.toMatchObject({ status: 403 });
    expect(repo.find).not.toHaveBeenCalled();
    expect(joinRepo.find).not.toHaveBeenCalled();
  });

  it.each(['column', 'join', 'sort', 'filter'])('denies a restricted field used as %s', async (kind) => {
    const { ctx, repo } = fixture();
    const config = ctx.action.params.config;
    if (kind === 'column') config.columns = [{ source: 0, field: 'secret' }];
    if (kind === 'join') config.joins[0].leftField = 'secret';
    if (kind === 'sort') ctx.action.params.sort = ['-secret'];
    if (kind === 'filter') config.primarySource.filter = { secret: 'hidden' };
    await expect(crossJoinQuery(ctx, vi.fn())).rejects.toMatchObject({ status: 403 });
    expect(repo.find).not.toHaveBeenCalled();
  });

  it('checks join permission even when the primary source has no rows', async () => {
    const { ctx, config, repo } = fixture();
    config.joins[0].collection = 'private';
    repo.find.mockResolvedValue([]);
    await expect(crossJoinQuery(ctx, vi.fn())).rejects.toMatchObject({ status: 403 });
    expect(repo.find).not.toHaveBeenCalled();
  });
});
