/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Application } from '@nocobase/server';
import type { Model } from '@nocobase/database';
import { describe, expect, it, vi } from 'vitest';
import PluginNextAppServer from '../plugin';

function fixture(shared: boolean) {
  type Hook = (instance: Model, options: { transaction?: undefined }) => Promise<void>;
  const hooks = new Map<string, Hook>();
  const flowModels = { create: vi.fn(), destroy: vi.fn() };
  const uiSchemas = { destroy: vi.fn() };
  const desktopRoutes = { findOne: vi.fn().mockResolvedValue(shared ? { schemaUid: 'desktop-page' } : null) };
  const repositories = {
    flowModels,
    uiSchemas,
    desktopRoutes,
    roles: { find: vi.fn().mockResolvedValue([]) },
    'nextAppRoutes.roles': { add: vi.fn() },
  };
  const db = {
    on: (name: string, hook: Hook) => hooks.set(name, hook),
    getRepository: (name: keyof typeof repositories) => repositories[name],
  };
  const app = { db } as unknown as Application;
  const plugin = new PluginNextAppServer(app, { name: 'next-app-client' });
  plugin.bindNewMenuToRoles();
  const instance = {
    id: 'hub-menu',
    get: (key: string) => (key === 'schemaUid' ? 'desktop-page' : undefined),
  } as unknown as Model;
  return { hooks, flowModels, uiSchemas, instance };
}

describe('Hub menu page ownership hooks with repository stubs', () => {
  it('does not create or destroy a model/schema owned by Desktop', async () => {
    const { hooks, flowModels, uiSchemas, instance } = fixture(true);
    await hooks.get('nextAppRoutes.afterCreate')?.(instance, {});
    await hooks.get('nextAppRoutes.afterDestroy')?.(instance, {});
    expect(flowModels.create).not.toHaveBeenCalled();
    expect(flowModels.destroy).not.toHaveBeenCalled();
    expect(uiSchemas.destroy).not.toHaveBeenCalled();
  });
  it('still initializes and cleans up a standalone Hub-owned schema', async () => {
    const { hooks, flowModels, uiSchemas, instance } = fixture(false);
    await hooks.get('nextAppRoutes.afterCreate')?.(instance, {});
    await hooks.get('nextAppRoutes.afterDestroy')?.(instance, {});
    expect(flowModels.create).toHaveBeenCalledWith(
      expect.objectContaining({ values: expect.objectContaining({ uid: 'desktop-page' }) }),
    );
    expect(flowModels.destroy).toHaveBeenCalledTimes(1);
    expect(uiSchemas.destroy).toHaveBeenCalledTimes(1);
  });
});
