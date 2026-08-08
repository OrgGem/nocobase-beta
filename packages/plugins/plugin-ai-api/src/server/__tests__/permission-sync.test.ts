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
import { invalidateUserPermissionCache, resolveUserAccessScope } from '../utils/user-permissions';

/**
 * Covers the cross-node half of permission revocation.
 *
 * syncMessageManager hardcodes `skipSelf: true` (sync-message-manager.ts:59,73), so the node
 * that writes the change never receives its own broadcast. That makes two things load-bearing
 * and easy to regress: the writer must invalidate its own cache locally, and every other node
 * must invalidate on receipt. Neither is observable from a single-node test of the cache alone.
 */
function mockContext(userId: number, row: unknown) {
  const findOne = vi.fn(async () => row);
  const ctx = {
    state: { currentUser: { id: userId } },
    db: { getRepository: () => ({ findOne }) },
    app: { name: 'main' },
    log: { warn: vi.fn(), error: vi.fn() },
  } as unknown as Context;
  return { ctx, findOne };
}

function row(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] };
}

beforeEach(() => {
  invalidateUserPermissionCache();
});

describe('cross-node permission invalidation', () => {
  it("drops the receiving node's cached scope", async () => {
    const plugin = Object.create(PluginAiApiServer.prototype) as PluginAiApiServer;
    const { ctx, findOne } = mockContext(1, row({ allowedLlmServices: ['openai'] }));

    await resolveUserAccessScope(ctx);
    await resolveUserAccessScope(ctx);
    expect(findOne).toHaveBeenCalledTimes(1);

    await plugin.handleSyncMessage({ type: 'invalidateUserPermissions', userId: 1 });

    await resolveUserAccessScope(ctx);
    expect(findOne).toHaveBeenCalledTimes(2);
  });

  it('ignores unrelated message types and other users', async () => {
    const plugin = Object.create(PluginAiApiServer.prototype) as PluginAiApiServer;
    const { ctx, findOne } = mockContext(1, row({ allowedLlmServices: ['openai'] }));
    await resolveUserAccessScope(ctx);

    await plugin.handleSyncMessage({ type: 'somethingElse', userId: 1 });
    await plugin.handleSyncMessage({ type: 'invalidateUserPermissions', userId: 2 });

    await resolveUserAccessScope(ctx);
    expect(findOne).toHaveBeenCalledTimes(1);
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

    const { ctx, findOne } = mockContext(1, row({ allowedLlmServices: ['openai'] }));
    await resolveUserAccessScope(ctx);
    expect(findOne).toHaveBeenCalledTimes(1);

    // revokeUserPermissions is private; reach it the way the db hook does.
    (plugin as unknown as { revokeUserPermissions: (id: unknown, tx?: unknown) => void }).revokeUserPermissions(1);

    // Local cache cleared without any message coming back to us.
    await resolveUserAccessScope(ctx);
    expect(findOne).toHaveBeenCalledTimes(2);
    expect(sendSyncMessage).toHaveBeenCalledWith(
      { type: 'invalidateUserPermissions', userId: 1 },
      { transaction: undefined },
    );
  });

  it('defers the broadcast to the transaction so other nodes cannot re-cache the old row', async () => {
    const plugin = Object.create(PluginAiApiServer.prototype) as PluginAiApiServer;
    const sendSyncMessage = vi.fn(async () => undefined);
    Object.assign(plugin, { sendSyncMessage });
    const transaction = { id: 'tx-1' };

    (plugin as unknown as { revokeUserPermissions: (id: unknown, tx?: unknown) => void }).revokeUserPermissions(
      7,
      transaction,
    );

    expect(sendSyncMessage).toHaveBeenCalledWith({ type: 'invalidateUserPermissions', userId: 7 }, { transaction });
  });
});
