// SPDX-License-Identifier: Apache-2.0

import { ACL } from '@nocobase/acl';
import { describe, expect, it, vi } from 'vitest';
import { PluginSftpPrivateStorageServer } from '../plugin';

describe('attachment fallback data scope', () => {
  it('checks the requested attachment under the rendered role filter', async () => {
    const acl = new ACL();
    acl.define({ role: 'reader', actions: { 'attachments:view': { filter: { createdById: 7 } } } });
    const findOne = vi.fn(async () => null);
    const db = { getRepository: () => ({ findOne }), getCollection: () => ({ getField: () => ({}) }) };
    const plugin = Object.create(PluginSftpPrivateStorageServer.prototype);
    Object.defineProperties(plugin, {
      app: { value: { acl } },
      db: { value: db },
      getParentCollections: { value: () => [] },
    });
    const ctx = { db, state: { currentRoles: ['reader'], currentUser: { id: 7 } } };
    expect(await plugin.checkParentCollectionAccess(99, 'attachments', ['reader'], ctx)).toBe(false);
    expect(findOne).toHaveBeenCalledWith({ filterByTk: 99, filter: { createdById: 7 }, context: ctx });
    findOne.mockResolvedValue({ id: 7 } as never);
    expect(await plugin.checkParentCollectionAccess(7, 'attachments', ['reader'], ctx)).toBe(true);
  });

  it('denies absent read permission without looking up the file', async () => {
    const acl = new ACL();
    const findOne = vi.fn();
    const plugin = Object.create(PluginSftpPrivateStorageServer.prototype);
    Object.defineProperties(plugin, {
      app: { value: { acl } },
      db: { value: { getRepository: () => ({ findOne }) } },
      getParentCollections: { value: () => [] },
    });
    expect(
      await plugin.checkParentCollectionAccess(99, 'attachments', ['member'], { state: { currentRoles: ['member'] } }),
    ).toBe(false);
    expect(findOne).not.toHaveBeenCalled();
  });
});
