/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { FlowEngine, FlowEngineProvider } from '@nocobase/flow-engine';
import { RouterManager } from '@nocobase/client-v2';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { Request as FetchRequest } from 'node-fetch';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, Outlet, RouterProvider, useLocation, useParams } from 'react-router-dom';
import {
  AliasAwareAdminLayoutEntry,
  AliasAwareAdminLayoutMenuItemModel,
  AliasAwareAdminLayoutModel,
  installFriendlyPathAliases,
} from '../pathAliasRuntime';
import type { NocoBaseDesktopRoute } from '@nocobase/client-v2';
import { AdminLayoutEntryGuard } from '../../../../../core/client-v2/src/flow/admin-shell/admin-layout/AdminLayoutEntryGuard';
import { AdminLayoutContent } from '../../../../../core/client-v2/src/flow/admin-shell/admin-layout/AdminLayoutSlotModels';

const aliasRoute = {
  id: 9007199254740991,
  type: 'flowPage',
  title: 'Sales dashboard',
  schemaUid: 'native-flow-page',
  options: { pathAlias: 'sales-dashboard' },
} as NocoBaseDesktopRoute;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const createLayoutModel = (routeRepository: Record<string, unknown>) => {
  const engine = new FlowEngine();
  engine.registerModels({ AdminLayoutModel: AliasAwareAdminLayoutModel });
  engine.context.defineProperty('routeRepository', { value: routeRepository });
  engine.context.defineProperty('app', { value: { router: { getBasename: () => '' } } });
  const model = engine.createModel<AliasAwareAdminLayoutModel>({
    uid: 'workspace-layout',
    use: 'AdminLayoutModel',
    props: {
      layout: {
        routeName: 'workspace',
        routePath: '/workspace',
        uid: 'workspace-layout',
      },
    },
  });
  return { engine, model };
};

const ResolvedPage = ({ model }: { model: AliasAwareAdminLayoutModel }) => {
  const location = useLocation();
  const params = useParams();
  const route = model.resolveLayoutRoute({
    layoutRouteName: 'workspace',
    layoutBasePathname: '/workspace',
    pathname: location.pathname,
    params,
  });
  const repository = model.flowEngine.context.routeRepository as {
    getRouteBySchemaUid?: (schemaUid: string) => unknown;
  };
  const authorized = route.type === 'page' && route.pageUid ? !!repository.getRouteBySchemaUid?.(route.pageUid) : false;
  return <output data-testid="resolved-page">{JSON.stringify({ location, params, route, authorized })}</output>;
};

const createGuardedLayoutEntry = (engine: FlowEngine, model: AliasAwareAdminLayoutModel) => (
  <FlowEngineProvider engine={engine}>
    <AliasAwareAdminLayoutEntry model={model}>
      <AdminLayoutEntryGuard model={model}>
        <Outlet />
      </AdminLayoutEntryGuard>
    </AliasAwareAdminLayoutEntry>
  </FlowEngineProvider>
);

const createKeepAliveLayoutEntry = (
  engine: FlowEngine,
  model: AliasAwareAdminLayoutModel,
  children: React.ReactNode,
) => (
  <FlowEngineProvider engine={engine}>
    <AliasAwareAdminLayoutEntry model={model}>
      <AdminLayoutEntryGuard model={model}>{children}</AdminLayoutEntryGuard>
    </AliasAwareAdminLayoutEntry>
  </FlowEngineProvider>
);

describe('friendly alias integration', () => {
  it('waits for the selected layout ACL routes, preserves native page identity, and replaces canonical deep links with the alias', async () => {
    vi.stubGlobal('Request', FetchRequest);
    let accessibleLoaded = false;
    let activeLayoutUid: string | undefined;
    let resolveAccessible: (() => void) | undefined;
    const accessiblePromise = new Promise<void>((resolve) => {
      resolveAccessible = () => {
        accessibleLoaded = true;
        resolve();
      };
    });
    const routeRepository = {
      activateLayout: vi.fn((layout?: { uid?: string }) => {
        activeLayoutUid = layout?.uid;
        return () => {
          activeLayoutUid = undefined;
        };
      }),
      ensureAccessibleLoaded: vi.fn(async () => {
        expect(activeLayoutUid).toBe('workspace-layout');
        await accessiblePromise;
      }),
      isAccessibleLoaded: vi.fn(() => accessibleLoaded),
      listAccessible: vi.fn(() => (accessibleLoaded ? [aliasRoute] : [])),
      getRouteBySchemaUid: vi.fn((schemaUid: string) =>
        accessibleLoaded && schemaUid === aliasRoute.schemaUid ? aliasRoute : undefined,
      ),
    };
    const { engine, model } = createLayoutModel(routeRepository);
    const router = createMemoryRouter(
      [
        {
          id: 'workspace',
          path: '/workspace',
          element: createGuardedLayoutEntry(engine, model),
          children: [
            {
              id: 'workspace.page',
              path: ':name/*',
              element: React.createElement(ResolvedPage, { model }),
            },
          ],
        },
      ],
      {
        initialEntries: [
          '/workspace/native-flow-page/tab/detail/view/modal/tab/modal-tab/filterbytk/123?status=open#summary',
        ],
      },
    );
    render(React.createElement(RouterProvider, { router }));

    expect(screen.queryByTestId('resolved-page')).toBeNull();
    expect(routeRepository.ensureAccessibleLoaded).toHaveBeenCalledTimes(1);
    expect(activeLayoutUid).toBe('workspace-layout');

    await act(async () => {
      resolveAccessible?.();
      await accessiblePromise;
    });

    const resolvedPage = await screen.findByTestId('resolved-page');
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        '/workspace/sales-dashboard/tab/detail/view/modal/tab/modal-tab/filterbytk/123',
      ),
    );
    const resolved = JSON.parse(resolvedPage.textContent || '{}') as {
      location: { pathname: string; search: string; hash: string };
      params: { name?: string };
      route: { pageUid?: string; tabUid?: string; viewStack?: Array<{ viewUid?: string; tabUid?: string }> };
    };
    expect(resolved).toMatchObject({
      location: {
        pathname: '/workspace/sales-dashboard/tab/detail/view/modal/tab/modal-tab/filterbytk/123',
        search: '?status=open',
        hash: '#summary',
      },
      params: { name: 'sales-dashboard' },
      route: {
        type: 'page',
        pageUid: 'native-flow-page',
        tabUid: 'detail',
        viewStack: [
          { viewUid: 'native-flow-page', tabUid: 'detail' },
          { viewUid: 'modal', tabUid: 'modal-tab' },
        ],
      },
      authorized: true,
    });
    expect(routeRepository.getRouteBySchemaUid).toHaveBeenCalledWith('native-flow-page');
  });

  it('does not resolve an alias for a route missing from the accessible route tree', async () => {
    vi.stubGlobal('Request', FetchRequest);
    const routeRepository = {
      activateLayout: vi.fn(() => vi.fn()),
      ensureAccessibleLoaded: vi.fn(async () => undefined),
      isAccessibleLoaded: vi.fn(() => false),
      listAccessible: vi.fn(() => []),
      getRouteBySchemaUid: vi.fn(() => undefined),
    };
    const { engine, model } = createLayoutModel(routeRepository);
    const router = createMemoryRouter(
      [
        {
          id: 'workspace',
          path: '/workspace',
          element: createGuardedLayoutEntry(engine, model),
          children: [
            {
              id: 'workspace.page',
              path: ':name/*',
              element: React.createElement(ResolvedPage, { model }),
            },
          ],
        },
      ],
      { initialEntries: ['/workspace/sales-dashboard'] },
    );
    render(React.createElement(RouterProvider, { router }));

    const resolvedPage = await screen.findByTestId('resolved-page');
    expect(JSON.parse(resolvedPage.textContent || '{}')).toMatchObject({
      location: { pathname: '/workspace/sales-dashboard' },
      route: { type: 'page', pageUid: 'sales-dashboard' },
      authorized: false,
    });
    expect(routeRepository.getRouteBySchemaUid).toHaveBeenCalledWith('sales-dashboard');
    expect(routeRepository.getRouteBySchemaUid).not.toHaveBeenCalledWith('native-flow-page');
  });

  it('replaces a remotely renamed active alias and clears the old KeepAlive entry', async () => {
    vi.stubGlobal('Request', FetchRequest);
    const oldRoute = { ...aliasRoute, options: { pathAlias: 'old-dashboard' } };
    let accessibleRoutes: NocoBaseDesktopRoute[] = [oldRoute];
    const subscribers = new Set<() => void>();
    const routeRepository = {
      activateLayout: vi.fn(() => vi.fn()),
      ensureAccessibleLoaded: vi.fn(async () => undefined),
      isAccessibleLoaded: vi.fn(() => true),
      listAccessible: vi.fn(() => accessibleRoutes),
      getRouteBySchemaUid: vi.fn((schemaUid: string) =>
        accessibleRoutes.find((route) => route.schemaUid === schemaUid),
      ),
      subscribe: vi.fn((subscriber: () => void) => {
        subscribers.add(subscriber);
        return () => {
          subscribers.delete(subscriber);
        };
      }),
    };
    const { engine, model } = createLayoutModel(routeRepository);
    const layout = model.layout;
    let pageMountCount = 0;
    const CachedPage = () => {
      const location = useLocation();
      const params = useParams();
      const route = model.resolveLayoutRoute({
        layoutRouteName: 'workspace',
        layoutBasePathname: '/workspace',
        pathname: location.pathname,
        params,
      });
      const [pageMount] = useState(() => ++pageMountCount);
      return (
        <output data-testid="cached-page" data-page-uid={route.type === 'page' ? route.pageUid : undefined}>
          {`${pageMount}:${params.name}`}
        </output>
      );
    };
    const RemoteMenu = () => {
      const [routes, setRoutes] = useState(() => routeRepository.listAccessible());
      React.useEffect(() => {
        return routeRepository.subscribe(() => setRoutes(routeRepository.listAccessible()));
      }, []);
      return <nav data-testid="remote-menu">{routes.map((route) => route.options?.pathAlias).join(',')}</nav>;
    };
    const router = createMemoryRouter(
      [
        {
          id: 'workspace',
          path: '/workspace',
          element: createKeepAliveLayoutEntry(
            engine,
            model,
            React.createElement(
              React.Fragment,
              null,
              React.createElement(RemoteMenu),
              React.createElement(AdminLayoutContent, { layout }),
            ),
          ),
          children: [{ id: 'workspace.__page', path: ':name', element: React.createElement(CachedPage) }],
        },
      ],
      { initialEntries: ['/workspace/old-dashboard'] },
    );
    render(React.createElement(RouterProvider, { router }));

    expect((await screen.findByTestId('cached-page')).getAttribute('data-page-uid')).toBe('native-flow-page');
    expect(screen.getAllByTestId('cached-page')).toHaveLength(1);

    await act(async () => {
      accessibleRoutes = [aliasRoute];
      subscribers.forEach((subscriber) => subscriber());
    });

    await waitFor(() => expect(router.state.location.pathname).toBe('/workspace/sales-dashboard'));
    expect((await screen.findByTestId('remote-menu')).textContent).toContain('sales-dashboard');
    expect(screen.getAllByTestId('cached-page')).toHaveLength(1);
    expect(screen.getByTestId('cached-page').getAttribute('data-page-uid')).toBe('native-flow-page');
  });

  it('clears a cached alias for another page when the route map changes, including browser Back', async () => {
    vi.stubGlobal('Request', FetchRequest);
    const oldRoute = { ...aliasRoute, options: { pathAlias: 'old-dashboard' } };
    const otherRoute = {
      id: 100,
      type: 'flowPage',
      title: 'Other page',
      schemaUid: 'other-page',
    } as NocoBaseDesktopRoute;
    let accessibleRoutes: NocoBaseDesktopRoute[] = [oldRoute, otherRoute];
    const subscribers = new Set<() => void>();
    const routeRepository = {
      activateLayout: vi.fn(() => vi.fn()),
      ensureAccessibleLoaded: vi.fn(async () => undefined),
      isAccessibleLoaded: vi.fn(() => true),
      listAccessible: vi.fn(() => accessibleRoutes),
      getRouteBySchemaUid: vi.fn((schemaUid: string) =>
        accessibleRoutes.find((route) => route.schemaUid === schemaUid),
      ),
      subscribe: vi.fn((subscriber: () => void) => {
        subscribers.add(subscriber);
        return () => {
          subscribers.delete(subscriber);
        };
      }),
    };
    const { engine, model } = createLayoutModel(routeRepository);
    const layout = model.layout;
    let pageMountCount = 0;
    const CachedPage = () => {
      const location = useLocation();
      const params = useParams();
      const route = model.resolveLayoutRoute({
        layoutRouteName: 'workspace',
        layoutBasePathname: '/workspace',
        pathname: location.pathname,
        params,
      });
      const [pageMount] = useState(() => ++pageMountCount);
      const [draft, setDraft] = useState('');
      return (
        <>
          <input
            aria-label={`Draft ${params.name}`}
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
          <output data-testid="cached-page" data-page-uid={route.type === 'page' ? route.pageUid : undefined}>
            {`${pageMount}:${params.name}`}
          </output>
        </>
      );
    };
    const RemoteMenu = () => {
      const [routes, setRoutes] = useState(() => routeRepository.listAccessible());
      React.useEffect(() => {
        return routeRepository.subscribe(() => setRoutes(routeRepository.listAccessible()));
      }, []);
      return <nav data-testid="remote-menu">{routes.map((route) => route.options?.pathAlias).join(',')}</nav>;
    };
    const router = createMemoryRouter(
      [
        {
          id: 'workspace',
          path: '/workspace',
          element: createKeepAliveLayoutEntry(
            engine,
            model,
            React.createElement(
              React.Fragment,
              null,
              React.createElement(RemoteMenu),
              React.createElement(AdminLayoutContent, { layout }),
            ),
          ),
          children: [{ id: 'workspace.__page', path: ':name', element: React.createElement(CachedPage) }],
        },
      ],
      { initialEntries: ['/workspace/old-dashboard'] },
    );
    render(React.createElement(RouterProvider, { router }));

    expect((await screen.findByTestId('cached-page')).getAttribute('data-page-uid')).toBe('native-flow-page');
    await act(async () => {
      await router.navigate('/workspace/other-page');
    });
    expect(screen.getAllByTestId('cached-page')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Draft other-page'), { target: { value: 'unsaved draft' } });
    expect((screen.getByLabelText('Draft other-page') as HTMLInputElement).value).toBe('unsaved draft');

    await act(async () => {
      accessibleRoutes = [aliasRoute, otherRoute];
      subscribers.forEach((subscriber) => subscriber());
    });
    expect((await screen.findByTestId('remote-menu')).textContent).toContain('sales-dashboard');
    expect(router.state.location.pathname).toBe('/workspace/other-page');
    expect(screen.getAllByTestId('cached-page')).toHaveLength(2);
    expect((screen.getByLabelText('Draft other-page') as HTMLInputElement).value).toBe('unsaved draft');

    await act(async () => {
      await router.navigate('/workspace/sales-dashboard');
    });
    expect(router.state.location.pathname).toBe('/workspace/sales-dashboard');
    expect(screen.getAllByTestId('cached-page')).toHaveLength(2);
    expect(
      screen
        .getAllByTestId('cached-page')
        .filter((element) => element.getAttribute('data-page-uid') === 'native-flow-page'),
    ).toHaveLength(1);
    expect((screen.getByLabelText('Draft other-page') as HTMLInputElement).value).toBe('unsaved draft');

    await act(async () => {
      accessibleRoutes = [{ ...aliasRoute, options: { pathAlias: 'sales-v2' } }, otherRoute];
      subscribers.forEach((subscriber) => subscriber());
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/workspace/sales-v2'));
    expect(screen.getAllByTestId('cached-page')).toHaveLength(2);
    expect(
      screen
        .getAllByTestId('cached-page')
        .filter((element) => element.getAttribute('data-page-uid') === 'native-flow-page'),
    ).toHaveLength(1);
    expect((screen.getByLabelText('Draft other-page') as HTMLInputElement).value).toBe('unsaved draft');

    await act(async () => {
      await router.navigate(-1);
    });
    expect(router.state.location.pathname).toBe('/workspace/other-page');
    expect(
      screen
        .getAllByTestId('cached-page')
        .filter((element) => element.getAttribute('data-page-uid') === 'native-flow-page'),
    ).toHaveLength(1);
    expect((screen.getByLabelText('Draft other-page') as HTMLInputElement).value).toBe('unsaved draft');

    await act(async () => {
      await router.navigate('/workspace/old-dashboard');
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/workspace/sales-v2'));
    expect(
      screen
        .getAllByTestId('cached-page')
        .filter((element) => element.getAttribute('data-page-uid') === 'native-flow-page'),
    ).toHaveLength(1);
    expect((screen.getByLabelText('Draft other-page') as HTMLInputElement).value).toBe('unsaved draft');
  });

  it('rewrites both RouterManager navigation entry points, preserves history state, and leaves mobile layouts untouched', async () => {
    vi.stubGlobal('Request', FetchRequest);
    const engine = new FlowEngine();
    engine.context.defineProperty('routeRepository', { value: { listAccessible: () => [aliasRoute] } });
    const app = {
      flowEngine: engine,
      getPublicPath: () => '/v2/',
      layoutManager: {
        listLayouts: () => [
          { layoutModelClass: 'AdminLayoutModel', routePath: '/admin' },
          { layoutModelClass: 'MobileLayoutModel', routePath: '/mobile' },
        ],
        getLayout: () => ({ routePath: '/admin' }),
      },
      renderComponent: () => null,
    };
    const manager = new RouterManager(
      {
        type: 'memory',
        initialEntries: ['/admin'],
        routes: {
          admin: { path: '/admin', element: React.createElement(Outlet) },
          'admin.page': { path: ':name/*', element: React.createElement('div') },
        },
      },
      app as never,
    );
    Object.assign(app, { router: manager });
    installFriendlyPathAliases(app as never);
    manager.getRouterComponent();

    await act(async () => {
      await manager.navigate(
        { pathname: '/admin/native-flow-page', search: '?status=open', hash: '#summary' },
        { state: { origin: 'manager' } },
      );
    });
    expect(manager.router.state.location).toMatchObject({
      pathname: '/admin/sales-dashboard',
      search: '?status=open',
      hash: '#summary',
      state: { origin: 'manager' },
    });

    await act(async () => {
      await manager.router.navigate('/v2/admin/native-flow-page/tab/details');
    });
    expect(manager.router.state.location.pathname).toBe('/v2/admin/sales-dashboard/tab/details');

    await act(async () => {
      await manager.router.navigate('/mobile/native-flow-page');
    });
    expect(manager.router.state.location.pathname).toBe('/mobile/native-flow-page');

    await act(async () => {
      await manager.router.navigate(-1);
    });
    expect(manager.router.state.location.pathname).toBe('/v2/admin/sales-dashboard/tab/details');
    await act(async () => {
      await manager.router.navigate(-1);
    });
    expect(manager.router.state.location.pathname).toBe('/admin/sales-dashboard');
    await act(async () => {
      await manager.router.navigate(1);
    });
    expect(manager.router.state.location.pathname).toBe('/v2/admin/sales-dashboard/tab/details');
  });

  it('uses aliases in menu routes and navigates away when deleting the current aliased page', async () => {
    const app = {
      getPublicPath: () => '/v2/',
      router: { getBasename: () => '/v2' },
    };
    const navigation = vi.fn();
    const deleteRoute = vi.fn(async () => undefined);
    const routeRepository = {
      listAccessible: () => [aliasRoute, { id: 'sibling', type: 'flowPage', schemaUid: 'other-page' }],
      deleteRoute,
    };
    const engine = new FlowEngine();
    engine.registerModels({ AdminLayoutMenuItemModel: AliasAwareAdminLayoutMenuItemModel });
    engine.context.defineProperty('app', { value: app });
    engine.context.defineProperty('layout', { value: { routePath: '/workspace' } });
    engine.context.defineProperty('location', { value: { pathname: '/workspace/sales-dashboard/tab/details' } });
    engine.context.defineProperty('router', { value: { basename: '/v2', navigate: navigation } });
    engine.context.defineProperty('routeRepository', { value: routeRepository });
    const menuItem = engine.createModel<AliasAwareAdminLayoutMenuItemModel>({
      uid: 'sales-menu',
      use: 'AdminLayoutMenuItemModel',
      props: { route: aliasRoute },
    });

    expect(
      menuItem.toProLayoutRoute({ designable: false, isMobile: false, t: (title) => title as string }),
    ).toMatchObject({
      path: '/workspace/sales-dashboard',
      redirect: '/workspace/sales-dashboard',
      _runtimePath: '/v2/workspace/sales-dashboard',
    });

    await expect(menuItem.destroy()).resolves.toBe(true);
    expect(deleteRoute).toHaveBeenCalledWith(aliasRoute.id);
    expect(navigation).toHaveBeenCalledWith('/workspace/other-page');
  });
});
