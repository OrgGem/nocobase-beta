/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context, Next } from '@nocobase/actions';
import { describe, expect, it, vi } from 'vitest';
import aiApiUserPermissionsResource from '../resource/ai-api-user-permissions';

type ActionHandler = (ctx: Context, next: Next) => Promise<void>;

const listUsers = aiApiUserPermissionsResource.actions?.listUsers as ActionHandler;

function model(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] };
}

describe('aiApiUserPermissions:listUsers', () => {
  it('returns the canonical rows shape for NocoBase data wrapping', async () => {
    const user = model({
      id: 7,
      nickname: 'Ada',
      username: 'ada',
      email: 'ada@example.com',
      password: 'must-not-leak',
    });
    const findAndCount = vi.fn(async () => [[user], 1] as const);
    const ctx = {
      action: { params: {} },
      db: { getRepository: () => ({ findAndCount }) },
    } as unknown as Context;

    await listUsers(ctx, async () => undefined);

    expect(ctx.body).toEqual({
      rows: [{ id: 7, nickname: 'Ada', username: 'ada', email: 'ada@example.com' }],
      count: 1,
      page: 1,
      pageSize: 50,
    });
    expect(findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ fields: ['id', 'nickname', 'username', 'email'] }),
    );
  });

  it('excludes users that already hold a grant when requested', async () => {
    const findAndCount = vi.fn(async () => [[], 0] as const);
    const ctx = {
      action: { params: { excludeGranted: true } },
      db: {
        getRepository: (name: string) =>
          name === 'aiApiUserPermissions'
            ? { find: vi.fn(async () => [model({ userId: 3 }), model({ userId: 8 })]) }
            : { findAndCount },
      },
    } as unknown as Context;

    await listUsers(ctx, async () => undefined);

    expect(findAndCount).toHaveBeenCalledWith(expect.objectContaining({ filter: { id: { $notIn: [3, 8] } } }));
  });
});
