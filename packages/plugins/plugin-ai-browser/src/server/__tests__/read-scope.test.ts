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
import { describe, expect, it, vi } from 'vitest';
import { scopeBrowserReads } from '../read-scope';

describe('AI Browser generic read scope', () => {
  it.each([
    ['aiBrowserProfiles', 'ownerId'],
    ['aiBrowserSessions', 'ownerId'],
    ['aiBrowserWorkflowCaches', 'ownerId'],
    ['aiBrowserTasks', 'session.ownerId'],
    ['aiBrowserActionEvents', 'session.ownerId'],
  ])('scopes list/get of %s and prevents association/secret expansion', async (name, ownerField) => {
    const acl = new ACL();
    acl.define({ role: 'member' });
    const ctx = {
      app: { acl },
      state: { currentRoles: ['member'], currentUser: { id: 7 } },
      action: {
        resourceName: name,
        params: {
          filterByTk: 'other-record',
          filter: { ownerId: 99 },
          appends: ['profile'],
          fields: ['id', 'profile.cookies', 'cookies', 'localStorage'],
        },
      },
      getCurrentRepository: () => ({
        collection: { name, getFields: () => new Map([['profile', { name: 'profile', isRelationField: () => true }]]) },
      }),
    } as unknown as Context;
    await scopeBrowserReads(ctx, vi.fn());
    expect(ctx.action.params.filter).toEqual({ $and: [{ ownerId: 99 }, { [ownerField]: 7 }] });
    expect(ctx.action.params.filterByTk).toBe('other-record');
    expect(ctx.action.params.appends).toEqual([]);
    expect(ctx.action.params.fields).toEqual(['id']);
    expect(ctx.action.params.except).toEqual(expect.arrayContaining(['profile', 'cookies', 'localStorage']));
  });

  it('preserves administrator reads and ignores unrelated resources', async () => {
    const acl = new ACL();
    acl.define({ role: 'admin', actions: { 'aiBrowser:setConfig': {} } });
    const ctx = {
      app: { acl },
      state: { currentRoles: ['admin'] },
      action: { resourceName: 'aiBrowserProfiles', params: {} },
      getCurrentRepository: vi.fn(() => ({ collection: { name: 'aiBrowserProfiles' } })),
    } as unknown as Context;
    const next = vi.fn();
    await scopeBrowserReads(ctx, next);
    expect(ctx.action.params).toEqual({});
    ctx.action.resourceName = 'packageRegistry';
    await scopeBrowserReads(ctx, next);
    expect(ctx.getCurrentRepository).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledTimes(2);
  });
});
