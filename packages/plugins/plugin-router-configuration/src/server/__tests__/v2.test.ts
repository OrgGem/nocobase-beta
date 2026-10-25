/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Application } from '@nocobase/server';
import { describe, expect, it, vi } from 'vitest';
import Plugin from '../plugin';

describe('V2 route identity protection', () => {
  it('does not rename a FlowModel-backed page through the V1 uiSchemas action or grant every logged-in user write access', async () => {
    const handlers = new Map<string, (ctx: unknown, next: () => Promise<void>) => Promise<void>>();
    const acl = { registerSnippet: vi.fn(), allow: vi.fn() };
    const app = {
      acl,
      resourceManager: {
        registerActionHandler: (name: string, handler: (ctx: unknown, next: () => Promise<void>) => Promise<void>) =>
          handlers.set(name, handler),
      },
    };
    await new Plugin(app as unknown as Application, { name: 'router-configuration' }).load();
    const update = vi.fn();
    const transaction = vi.fn();
    const ctx = {
      action: { params: { values: { id: '90071992547409933', schemaUid: 'new-path' } } },
      request: { body: {} },
      db: {
        getRepository: () => ({
          findOne: async () => ({ get: (key: string) => (key === 'type' ? 'flowPage' : 'old-path') }),
          update,
        }),
        sequelize: { transaction },
      },
      throw(status: number, message: string): never {
        throw Object.assign(new Error(message), { status });
      },
    };
    await expect(handlers.get('desktopRoutes:renamePath')(ctx, async () => undefined)).rejects.toMatchObject({
      status: 409,
    });
    expect(update).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(acl.allow).not.toHaveBeenCalled();
    expect(acl.registerSnippet).toHaveBeenCalledWith({
      name: 'pm.router-configuration',
      actions: ['desktopRoutes:list', 'desktopRoutes:renamePath'],
    });
  });
});
