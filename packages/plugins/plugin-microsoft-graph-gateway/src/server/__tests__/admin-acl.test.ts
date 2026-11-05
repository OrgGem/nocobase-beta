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
import Plugin from '../plugin';

it('requires a real admin grant for Graph administration while retaining external API-key routes', async () => {
  const acl = new ACL();
  acl.define({ role: 'member' });
  acl.define({ role: 'gateway-admin' }).snippets.add('pm.microsoft-graph-gateway');
  const app = { acl, resourceManager: { define: vi.fn() }, on: vi.fn() };
  const plugin = new Plugin(app as never, { name: 'plugin-microsoft-graph-gateway' });
  await plugin.load();
  for (const actionName of [
    'getSettings',
    'saveSettings',
    'testConnection',
    'createApiKey',
    'listApiKeys',
    'revokeApiKey',
    'dashboard',
    'listJobs',
    'listAuditLogs',
    'openapi',
  ]) {
    const ctx = {
      state: { currentUser: { id: 7 }, currentRoles: ['member'] },
      action: { resourceName: 'msGraphGateway', actionName, params: {} },
      throw: (status: number) => {
        throw Object.assign(new Error('denied'), { status });
      },
    };
    const handler = vi.fn();
    await expect(acl.middleware()(ctx, handler)).rejects.toMatchObject({ status: 403 });
    expect(handler).not.toHaveBeenCalled();
    ctx.state.currentRoles = ['gateway-admin'];
    await acl.middleware()(ctx, handler);
    expect(handler).toHaveBeenCalledOnce();
  }
  expect(await acl.allowManager.isPublic('msGraphGateway', 'sendEmail', {})).toBe(true);
});
