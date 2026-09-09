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
import { blockResponseRecordResource, targetsResponseRecordCollection } from '../middleware/response-record-resource';

function context(resourceName: string, params: Record<string, unknown> = {}, targetCollection?: string): Context {
  return {
    action: { resourceName, actionName: 'list', params },
    getCurrentRepository: targetCollection ? () => ({ targetCollection: { name: targetCollection } }) : undefined,
    throw(status: number, message: string) {
      throw Object.assign(new Error(message), { status });
    },
  } as unknown as Context;
}

describe('Responses API private storage resource', () => {
  it.each([
    context('aiApiResponseRecords'),
    context('users.responses', { associatedName: 'aiApiResponseRecords' }),
    context('generic', { targetCollection: 'aiApiResponseRecords' }),
    context('generic', {}, 'aiApiResponseRecords'),
  ])('detects every generic route to the response record collection', (ctx) => {
    expect(targetsResponseRecordCollection(ctx)).toBe(true);
  });

  it('returns 404 before generic CRUD can expose stored prompts', async () => {
    const next = vi.fn() as unknown as Next;

    await expect(blockResponseRecordResource()(context('aiApiResponseRecords'), next)).rejects.toMatchObject({
      status: 404,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('does not affect unrelated resources', async () => {
    const next = vi.fn().mockResolvedValue(undefined) as unknown as Next;

    await blockResponseRecordResource()(context('users'), next);

    expect(next).toHaveBeenCalledOnce();
  });
});
