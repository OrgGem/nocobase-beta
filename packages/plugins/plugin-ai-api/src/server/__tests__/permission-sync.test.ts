/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Context } from '@nocobase/actions';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginAiApiServer } from '../plugin';
import { invalidateGroupAccessCache, resolveUserAccessScope } from '../utils/user-permissions';

/**
 * Covers the cross-node half of group-access invalidation.
 *
 * syncMessageManager hardcodes `skipSelf: true` (sync-message-manager.ts:59,73), so the node
 * that writes the change never receives its own broadcast. That makes two things load-bearing
 * and easy to regress: the writer must invalidate its own cache locally, and every other node
 * must invalidate on receipt. Neither is observable from a single-node test of the cache alone.
 */
function row(values: Record<string, unknown>) {
  return { get: (key?: string) => (key === undefined ? values : values[key]) };
}

function mockContext(userId: number, groupValues: Record<string, unknown>) {
  const group = row({ allowedLlmServices: [], allowAllModels: true, allowedModels: [], ...groupValues });
  const findOne = vi.fn(async () => row({ group }));
  const ctx = {
    state: { currentUser: { id: userId } },
    db: {
      getRepository: (name: string) =>
        name === 'aiApiGroupMembers' ? { findOne } : { findOne: async () => null, create: vi.fn() },
    },
    app: { name: 'main' },
    log: { warn: vi.fn(), error: vi.fn() },
  } as unknown as Context;
  return { ctx, findOne };
}

beforeEach(() => {
  invalidateGroupAccessCache();
});

describe('cross-node group access invalidation', () => {
  it("drops the receiving node's cached scope", async () => {
    const plugin = Object.create(PluginAiApiServer.prototype) as PluginAiApiServer;
    const { ctx } = mockContext(1, { id: 5, allowedLlmServices: ['openai'] });

    const before = await resolveUserAccessScope(ctx);
    expect(await resolveUserAccessScope(ctx)).toBe(before);

    await plugin.handleSyncMessage({ type: 'invalidateGroupAccess', groupId: 5 });

    expect(await resolveUserAccessScope(ctx)).not.toBe(before);
  });

  it('ignores unrelated message types and other groups', async () => {
    const plugin = Object.create(PluginAiApiServer.prototype) as PluginAiApiServer;
    const { ctx } = mockContext(1, { id: 5, allowedLlmServices: ['openai'] });
    const before = await resolveUserAccessScope(ctx);

    await plugin.handleSyncMessage({ type: 'somethingElse', groupId: 5 });
    await plugin.handleSyncMessage({ type: 'invalidateGroupAccess', groupId: 6 });

    expect(await resolveUserAccessScope(ctx)).toBe(before);
  });

  it('tolerates a malformed message instead of throwing into the subscriber', async () => {
    const plugin = Object.create(PluginAiApiServer.prototype) as PluginAiApiServer;
    await expect(plugin.handleSyncMessage(undefined as never)).resolves.toBeUndefined();
    await expect(plugin.handleSyncMessage({} as never)).resolves.toBeUndefined();
  });

  it('invalidates locally as well as broadcasting, since the publisher is skipped', async () => {
    const plugin = Object.create(PluginAiApiServer.prototype) as PluginAiApiServer;
    const sendSyncMessage = vi.fn(async () => undefined);
    Object.assign(plugin, { sendSyncMessage });

    const { ctx } = mockContext(1, { id: 5, allowedLlmServices: ['openai'] });
    const before = await resolveUserAccessScope(ctx);

    // invalidateGroupAccess is private; reach it the way the db hook does.
    (plugin as unknown as { invalidateGroupAccess: (id: unknown, tx?: unknown) => void }).invalidateGroupAccess(5);

    // Local cache cleared without any message coming back to us.
    expect(await resolveUserAccessScope(ctx)).not.toBe(before);
    expect(sendSyncMessage).toHaveBeenCalledWith(
      { type: 'invalidateGroupAccess', groupId: 5 },
      { transaction: undefined },
    );
  });

  it('defers the broadcast to the transaction so other nodes cannot re-cache the old row', async () => {
    const plugin = Object.create(PluginAiApiServer.prototype) as PluginAiApiServer;
    const sendSyncMessage = vi.fn(async () => undefined);
    Object.assign(plugin, { sendSyncMessage });
    const transaction = { id: 'tx-1' };

    (plugin as unknown as { invalidateGroupAccess: (id: unknown, tx?: unknown) => void }).invalidateGroupAccess(
      7,
      transaction,
    );

    expect(sendSyncMessage).toHaveBeenCalledWith({ type: 'invalidateGroupAccess', groupId: 7 }, { transaction });
  });
});
