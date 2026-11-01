/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { FlowEngine, FlowEngineProvider, FlowModel } from '@nocobase/flow-engine';
import '@testing-library/jest-dom/vitest';
import { act, render, screen, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Request as FetchRequest } from 'node-fetch';
import type { LayoutDefinition } from '@nocobase/client-v2';
import { HUB_LAYOUT_UID, NextAppLayoutModel, NextAppRuntime } from '../NextAppRuntime';
import { HubRouteRepository } from '../HubRouteRepository';
import { createHubEngine } from '../createHubEngine';

vi.mock('@nocobase/client-v2', async (importOriginal) => {
  const original = await importOriginal<typeof import('@nocobase/client-v2')>();
  return {
    ...original,
    PinnedPluginListLite: () => null,
    useSystemSettings: () => ({ data: { data: { title: 'Hub app' } } }),
  };
});
vi.mock('../locale', () => ({ useT: () => (key: string) => key }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const layout: LayoutDefinition = {
  routeName: 'hub',
  rootRouteName: 'hub',
  routePath: '/hub/:appPath',
  uid: HUB_LAYOUT_UID,
  layoutModelClass: 'NextAppLayoutModel',
  rootPageModelClass: 'RootPageModel',
  childPageModelClass: 'ChildPageModel',
  authCheck: true,
};

describe('Hub with actual V2 engine and layout model', () => {
  it('parses tab/view routes against the concrete Hub basename and isolates models from Desktop', () => {
    const parent = new FlowEngine();
    parent.registerModels({ NextAppLayoutModel });
    const desktopRepository = { listAccessible: () => [{ schemaUid: 'desktop' }] };
    parent.context.defineProperty('routeRepository', { value: desktopRepository });
    const desktop = parent.createModel({ uid: 'same-page', use: 'FlowModel' });
    const repository = new HubRouteRepository(
      { request: vi.fn() } as unknown as ConstructorParameters<typeof HubRouteRepository>[0],
      'sales',
    );
    const scoped = createHubEngine(parent, repository);
    expect(scoped.context.engine).toBe(scoped);
    const model = scoped.createModel<NextAppLayoutModel>({
      uid: HUB_LAYOUT_UID,
      use: 'NextAppLayoutModel',
      props: { layout },
    });
    const hubPage = scoped.createModel({ uid: 'same-page', use: 'FlowModel' });
    const resolved = model.resolveLayoutRoute({
      layoutRouteName: 'hub',
      layoutBasePathname: '/workspace/v2/hub/sales',
      pathname: '/workspace/v2/hub/sales/orders/tab/details/view/edit/filterbytk/42',
      params: { appPath: 'sales', name: 'orders' },
    });
    expect(resolved).toMatchObject({
      type: 'page',
      pageUid: 'orders',
      tabUid: 'details',
      basePathname: '/workspace/v2/hub/sales',
    });
    expect(hubPage).not.toBe(desktop);
    expect(parent.getModel('same-page')).toBe(desktop);
    expect(parent.context.routeRepository).toBe(desktopRepository);
    scoped.unlinkFromStack();
  });

  it('renders the native layout, replaces the scope on role change, and clears late results after unmount', async () => {
    // Node 24's global Request rejects JSDOM AbortSignal objects used by the memory router.
    vi.stubGlobal('Request', FetchRequest);
    const engine = new FlowEngine();
    engine.registerModels({ NextAppLayoutModel });
    const request = vi
      .fn()
      .mockResolvedValue({ data: { data: [{ id: '1', type: 'flowPage', schemaUid: 'orders', title: 'Orders' }] } });
    const eventBus = new EventTarget();
    const app = {
      apiClient: { request },
      eventBus,
      layoutManager: { getLayout: () => layout },
      pm: { get: () => undefined },
      i18n: { t: (key: string) => key },
      getRouteUrl: (path: string) => '/v2' + path,
      getPublicPath: () => '/v2/',
    };
    engine.context.defineProperty('app', { value: app });
    engine.context.defineProperty('api', { value: app.apiClient });
    const desktopRepository = { listAccessible: () => [] };
    engine.context.defineProperty('routeRepository', { value: desktopRepository });
    const router = createMemoryRouter(
      [
        {
          id: 'hub',
          path: '/hub/:appPath',
          element: <NextAppRuntime />,
          children: [{ id: 'hub.__page', path: ':name', element: <div>Native page content</div> }],
        },
      ],
      { initialEntries: ['/hub/sales/orders'] },
    );
    const rendered = render(
      <FlowEngineProvider engine={engine}>
        <RouterProvider router={router} />
      </FlowEngineProvider>,
    );
    expect(await screen.findByText('Native page content')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Orders' })).toHaveAttribute('href', '/hub/sales/orders');
    const first = engine.nextEngine;
    const oldRepository = first?.context.routeRepository as unknown as HubRouteRepository;
    act(() => eventBus.dispatchEvent(new Event('auth:roleChanged')));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(oldRepository.listAccessible()).toEqual([]);
    expect(engine.context.routeRepository).toBe(desktopRepository);
    await act(async () => {
      await router.navigate('/hub/operations/orders');
    });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ filter: { appPath: 'operations' } }) }),
    );
    expect(engine.context.routeRepository).toBe(desktopRepository);
    rendered.unmount();
    await waitFor(() => expect(engine.nextEngine).toBeUndefined());
  });
});
