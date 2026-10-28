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
import Plugin, { canMatchDesktopRouteId } from '../plugin';

type Query = Record<string, unknown>;
type RouteRecord = {
  id?: string | number;
  type?: string;
  schemaUid?: string;
  options?: Record<string, unknown>;
  children?: RouteRecord[];
  uiLayouts?: Array<{ layoutType?: string }>;
  get?: (key: string) => unknown;
};
type Transaction = { commit: () => Promise<void>; rollback: () => Promise<void> };
type Repository = {
  findOne?: (query?: Query) => Promise<unknown>;
  find?: (query?: Query) => Promise<unknown[]>;
  create?: (query?: Query) => Promise<unknown>;
  update?: (query?: Query) => Promise<unknown>;
  destroy?: (query?: Query) => Promise<unknown>;
};
type TestContext = {
  action: { params: Record<string, unknown>; actionName?: string; resourceName?: string };
  request: { body?: unknown };
  db: {
    getRepository: (name: string) => Repository;
    sequelize?: { transaction: () => Promise<Transaction> };
  };
  app?: { log?: { warn: (...args: unknown[]) => void } };
  body?: unknown;
  throw: (status: number, message: string) => never;
};
type Handler = (ctx: TestContext, next: () => Promise<void>) => Promise<void>;

const createHarness = async () => {
  const handlers = new Map<string, Handler>();
  const preActionHandlers = new Map<string, Handler>();
  const middlewares: Array<{ handler: Handler; options?: Record<string, unknown> }> = [];
  const acl = { registerSnippet: vi.fn() };
  const resourceManager = {
    registerActionHandler: vi.fn((name: string, handler: Handler) => handlers.set(name, handler)),
    registerPreActionHandler: vi.fn((name: string, handler: Handler) => preActionHandlers.set(name, handler)),
    use: vi.fn((handler: Handler, options?: Record<string, unknown>) => middlewares.push({ handler, options })),
  };
  const app = { acl, resourceManager };
  const plugin = new Plugin(app as unknown as Application, { name: 'router-configuration' });
  await plugin.load();
  return { handlers, preActionHandlers, middlewares, acl, resourceManager };
};

const createContext = (db: TestContext['db'], params: Record<string, unknown> = {}): TestContext => ({
  action: { params },
  request: { body: {} },
  db,
  throw(status, message): never {
    throw Object.assign(new Error(message), { status });
  },
});

describe('V2 route identity and friendly URL protection', () => {
  it('does not rename a FlowModel-backed page through the V1 rename action or grant every logged-in user write access', async () => {
    const { handlers, acl } = await createHarness();
    const update = vi.fn();
    const route: RouteRecord = {
      id: '90071992547409933',
      type: 'flowPage',
      schemaUid: 'old-path',
      get: (key) => (key === 'type' ? 'flowPage' : 'old-path'),
    };
    const db = {
      getRepository: (name: string): Repository =>
        name === 'desktopRoutes'
          ? {
              findOne: async () => route,
              update,
            }
          : { findOne: async () => null },
      sequelize: { transaction: vi.fn(async () => ({ commit: vi.fn(), rollback: vi.fn() })) },
    };
    const ctx = createContext(db, { values: { id: route.id, schemaUid: 'new-path' } });

    await expect(handlers.get('desktopRoutes:renamePath')?.(ctx, async () => undefined)).rejects.toMatchObject({
      status: 409,
    });
    expect(update).not.toHaveBeenCalled();
    expect(db.sequelize.transaction).not.toHaveBeenCalled();
    expect(acl.registerSnippet).toHaveBeenCalledWith({
      name: 'pm.router-configuration',
      actions: [
        'desktopRoutes:list',
        'desktopRoutes:renamePath',
        'desktopRoutes:listPathAliases',
        'desktopRoutes:setPathAlias',
      ],
    });
  });

  it('rejects legacy renames that collide with an existing V2 alias', async () => {
    const { handlers } = await createHarness();
    const update = vi.fn();
    const route: RouteRecord = {
      id: '17',
      type: 'page',
      schemaUid: 'legacy-path',
      get: (key) => (key === 'type' ? 'page' : 'legacy-path'),
    };
    const db = {
      getRepository: (name: string): Repository =>
        name === 'desktopRoutes'
          ? {
              findOne: async (query) => ((query?.filterByTk as string | undefined) ? route : null),
              update,
            }
          : {
              findOne: async (query) =>
                (query?.filter as { pathAlias?: string } | undefined)?.pathAlias === 'sales-dashboard'
                  ? { id: 'alias-1' }
                  : null,
            },
      sequelize: { transaction: vi.fn(async () => ({ commit: vi.fn(), rollback: vi.fn() })) },
    };
    const ctx = createContext(db, { values: { id: route.id, schemaUid: 'sales-dashboard' } });

    await expect(handlers.get('desktopRoutes:renamePath')?.(ctx, async () => undefined)).rejects.toMatchObject({
      status: 409,
    });
    expect(update).not.toHaveBeenCalled();
    expect(db.sequelize.transaction).not.toHaveBeenCalled();
  });

  it('does not send non-numeric or out-of-range friendly aliases to the BIGINT route id lookup', async () => {
    const { handlers } = await createHarness();
    const route: RouteRecord = {
      id: '42',
      type: 'flowPage',
      schemaUid: 'native-page',
      uiLayouts: [{ layoutType: 'desktop' }],
    };
    const routeFindOne = vi.fn(async (query?: Query) => {
      const filter = query?.filter as { schemaUid?: string } | undefined;
      if (filter?.schemaUid === 'sales-dashboard') {
        return null;
      }
      return query?.filterByTk ? route : null;
    });
    const aliasCreate = vi.fn(async () => ({ id: 'alias-1' }));
    const aliasFindOne = vi.fn(async () => null);
    const transaction = { commit: vi.fn(async () => undefined), rollback: vi.fn(async () => undefined) };
    const db = {
      getRepository: (name: string): Repository =>
        name === 'desktopRoutes' ? { findOne: routeFindOne } : { findOne: aliasFindOne, create: aliasCreate },
      sequelize: { transaction: vi.fn(async () => transaction) },
    };

    const ctx = createContext(db, { values: { id: route.id, pathAlias: 'sales-dashboard' } });
    await handlers.get('desktopRoutes:setPathAlias')?.(ctx, async () => undefined);

    expect(aliasCreate).toHaveBeenCalledWith({
      values: { desktopRouteId: route.id, pathAlias: 'sales-dashboard' },
      transaction,
    });
    expect(routeFindOne).not.toHaveBeenCalledWith({ filter: { id: 'sales-dashboard' } });
    expect(transaction.commit).toHaveBeenCalledOnce();

    const outOfRangeContext = createContext(
      {
        ...db,
        getRepository: (name: string): Repository =>
          name === 'desktopRoutes' ? { findOne: routeFindOne } : { findOne: aliasFindOne, create: aliasCreate },
      },
      { values: { id: route.id, pathAlias: '9223372036854775808' } },
    );
    await handlers.get('desktopRoutes:setPathAlias')?.(outOfRangeContext, async () => undefined);
    expect(routeFindOne).not.toHaveBeenCalledWith({ filter: { id: '9223372036854775808' } });
  });

  it('removes stale aliases after a route loses V2 or desktop-layout eligibility', async () => {
    for (const type of ['page', 'flowPage'] as const) {
      for (const pathAlias of [null, '', '   '] as const) {
        const { handlers } = await createHarness();
        const route: RouteRecord = { id: '42', type, schemaUid: 'legacy-page', uiLayouts: [] };
        const routeFindOne = vi.fn(async () => route);
        const aliasFindOne = vi.fn(async () => ({ id: 'alias-1', desktopRouteId: route.id, pathAlias: 'stale-alias' }));
        const aliasDestroy = vi.fn(async () => undefined);
        const db = {
          getRepository: (name: string): Repository =>
            name === 'desktopRoutes' ? { findOne: routeFindOne } : { findOne: aliasFindOne, destroy: aliasDestroy },
        };
        const ctx = createContext(db, { values: { id: route.id, pathAlias } });
        const next = vi.fn(async () => undefined);

        await handlers.get('desktopRoutes:setPathAlias')?.(ctx, next);

        expect(routeFindOne).toHaveBeenCalledWith({ filterByTk: route.id, appends: ['uiLayouts'] });
        expect(aliasFindOne).toHaveBeenCalledWith({ filter: { desktopRouteId: route.id } });
        expect(aliasDestroy).toHaveBeenCalledWith({ filterByTk: 'alias-1' });
        expect(ctx.body).toEqual({ success: true, pathAlias: null, message: 'Path alias removed' });
        expect(next).toHaveBeenCalledOnce();
      }
    }
  });

  it('still rejects new aliases for routes without V2 and desktop-layout eligibility', async () => {
    const { handlers } = await createHarness();
    const route: RouteRecord = { id: '42', type: 'flowPage', schemaUid: 'current-page', uiLayouts: [] };
    const routeFindOne = vi.fn(async () => route);
    const aliasFindOne = vi.fn(async () => null);
    const aliasCreate = vi.fn(async () => ({ id: 'alias-1' }));
    const db = {
      getRepository: (name: string): Repository =>
        name === 'desktopRoutes' ? { findOne: routeFindOne } : { findOne: aliasFindOne, create: aliasCreate },
    };
    const ctx = createContext(db, { values: { id: route.id, pathAlias: 'sales-dashboard' } });

    await expect(handlers.get('desktopRoutes:setPathAlias')?.(ctx, async () => undefined)).rejects.toMatchObject({
      status: 400,
    });
    expect(aliasFindOne).not.toHaveBeenCalled();
    expect(aliasCreate).not.toHaveBeenCalled();
  });

  it('requires an existing route before allowing alias removal', async () => {
    const { handlers } = await createHarness();
    const routeFindOne = vi.fn(async () => null);
    const aliasFindOne = vi.fn(async () => ({ id: 'alias-1' }));
    const db = {
      getRepository: (name: string): Repository =>
        name === 'desktopRoutes' ? { findOne: routeFindOne } : { findOne: aliasFindOne },
    };
    const ctx = createContext(db, { values: { id: '404', pathAlias: null } });

    await expect(handlers.get('desktopRoutes:setPathAlias')?.(ctx, async () => undefined)).rejects.toMatchObject({
      status: 404,
    });
    expect(aliasFindOne).not.toHaveBeenCalled();
  });

  it('bounds numeric route id matching before querying the BIGINT primary key', () => {
    expect(canMatchDesktopRouteId('7')).toBe(true);
    expect(canMatchDesktopRouteId('0007')).toBe(true);
    expect(canMatchDesktopRouteId('sales-dashboard')).toBe(false);
    expect(canMatchDesktopRouteId('9223372036854775807')).toBe(true);
    expect(canMatchDesktopRouteId('9223372036854775808')).toBe(false);
    expect(canMatchDesktopRouteId('999999999999999999999999')).toBe(false);
  });

  it('rejects native create/update aliases recursively, including nested tab children', async () => {
    const { preActionHandlers } = await createHarness();
    const aliasFindOne = vi.fn(async (query?: Query) =>
      (query?.filter as { pathAlias?: string } | undefined)?.pathAlias === 'sales-dashboard' ? { id: 'alias-1' } : null,
    );
    const db = { getRepository: () => ({ findOne: aliasFindOne }) };
    const next = vi.fn(async () => undefined);
    const ctx = createContext(db, {
      values: {
        schemaUid: 'new-group',
        children: [
          { type: 'tabs', schemaUid: 'tab-container' },
          { type: 'flowPage', schemaUid: 'sales-dashboard' },
        ],
      },
    });

    await expect(preActionHandlers.get('desktopRoutes:create')?.(ctx, next)).rejects.toMatchObject({ status: 409 });
    expect(aliasFindOne).toHaveBeenCalledWith({ filter: { pathAlias: 'sales-dashboard' } });
    expect(next).not.toHaveBeenCalled();
  });

  it('enriches only the final role-filtered desktop listAccessible response', async () => {
    const { middlewares } = await createHarness();
    const allowedRoute: RouteRecord = {
      id: '1',
      type: 'flowPage',
      schemaUid: 'allowed-page',
      options: { pathAlias: 'persisted-forgery', keep: true },
    };
    const allowedChild: RouteRecord = {
      id: '2',
      type: 'flowPage',
      schemaUid: 'allowed-child',
      options: { pathAlias: 'unbacked-legacy-alias', keep: true },
    };
    const aliasesFind = vi.fn(async () => [
      { desktopRouteId: '1', pathAlias: 'sales-dashboard' },
      { desktopRouteId: '999', pathAlias: 'hidden-route' },
    ]);
    const db = {
      getRepository: (name: string): Repository =>
        name === 'uiLayouts'
          ? { findOne: async () => ({ layoutType: 'desktop' }) }
          : name === 'desktopRoutePathAliases'
            ? { find: aliasesFind }
            : {},
    };
    const ctx: TestContext = {
      ...createContext(db),
      action: { actionName: 'listAccessible', resourceName: 'desktopRoutes', params: { layout: 'admin-layout-model' } },
      body: undefined,
    };
    const next = vi.fn(async () => {
      // Mimic ui-layout replacing the upstream body with the ACL-filtered tree.
      ctx.body = [{ ...allowedRoute, children: [allowedChild] }];
    });
    const middleware = middlewares[0];

    await middleware.handler(ctx, next);

    expect(middleware.options).toMatchObject({
      tag: 'plugin-router-configuration:accessible-path-aliases',
      before: 'auth',
    });
    expect(next).toHaveBeenCalledOnce();
    expect(aliasesFind).toHaveBeenCalledWith({ filter: { desktopRouteId: ['1', '2'] } });
    expect(ctx.body).toEqual([
      {
        ...allowedRoute,
        options: { pathAlias: 'sales-dashboard', keep: true },
        children: [{ ...allowedChild, options: { keep: true } }],
      },
    ]);
  });
});
