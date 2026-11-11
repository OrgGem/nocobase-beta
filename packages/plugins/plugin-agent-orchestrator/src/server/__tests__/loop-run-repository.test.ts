/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Database, FindOptions } from '@nocobase/database';
import { describe, expect, it, vi } from 'vitest';
import { LoopRunRepository } from '../services/LoopRunRepository';

describe('LoopRunRepository run pagination', () => {
  it('reads every owned run once across repository pages without including another owner', async () => {
    const rows = Array.from({ length: 5001 }, (_, index) => ({ id: index + 1, userId: 7 }));
    rows.push({ id: 5002, userId: 8 });
    const find = vi.fn(async (options: FindOptions) => {
      if (find.mock.calls.length > 2) throw new Error('Pagination did not terminate.');
      const ownerId = (options.filter as { userId?: number } | undefined)?.userId;
      const owned = rows.filter((row) => ownerId === undefined || row.userId === ownerId);
      const offset = options.offset || 0;
      return owned.slice(offset, options.limit === undefined ? undefined : offset + options.limit);
    });
    const database = { getRepository: () => ({ find }) } as unknown as Database;

    const ids = await new LoopRunRepository(database).listOwnedRunIds(7, false);

    expect(ids).toEqual(rows.slice(0, 5001).map((row) => row.id));
    expect(find).toHaveBeenCalledTimes(2);
  });
});
