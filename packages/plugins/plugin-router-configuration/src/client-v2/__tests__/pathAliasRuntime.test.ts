/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { FlowEngine } from '@nocobase/flow-engine';
import type { NocoBaseDesktopRoute } from '@nocobase/client-v2';
import {
  AliasAwareAdminLayoutModel,
  resolveAliasPathnameToSchemaUid,
  resolveSchemaUidPathnameToAlias,
} from '../pathAliasRuntime';

const accessibleRoutes = [
  {
    id: 9007199254740991,
    type: 'flowPage',
    schemaUid: 'native-flow-page',
    options: { pathAlias: 'sales-dashboard' },
  },
] as unknown as NocoBaseDesktopRoute[];

describe('friendly route aliases', () => {
  it('maps direct and nested alias URLs to the native FlowModel path while preserving search and hash', () => {
    expect(
      resolveAliasPathnameToSchemaUid('/apps/demo/admin/sales-dashboard?status=open#summary', '/apps/demo/admin', [
        ...accessibleRoutes,
      ]),
    ).toBe('/apps/demo/admin/native-flow-page?status=open#summary');

    expect(
      resolveAliasPathnameToSchemaUid(
        '/apps/demo/admin/sales-dashboard/tab/detail/view/modal/tab/modal-tab/filterbytk/123',
        '/apps/demo/admin',
        [...accessibleRoutes],
      ),
    ).toBe('/apps/demo/admin/native-flow-page/tab/detail/view/modal/tab/modal-tab/filterbytk/123');
  });

  it('rewrites native FlowModel navigation back to the alias, including nested tabs and views', () => {
    expect(
      resolveSchemaUidPathnameToAlias(
        '/apps/demo/admin/native-flow-page/tab/detail/view/modal/tab/modal-tab/filterbytk/123?x=1#top',
        '/apps/demo/admin',
        [...accessibleRoutes],
      ),
    ).toBe('/apps/demo/admin/sales-dashboard/tab/detail/view/modal/tab/modal-tab/filterbytk/123?x=1#top');
  });

  it('does not resolve an alias when the route is absent from the accessible route tree', () => {
    expect(resolveAliasPathnameToSchemaUid('/admin/sales-dashboard', '/admin', [])).toBe('/admin/sales-dashboard');
    expect(
      resolveAliasPathnameToSchemaUid(
        '/admin/old-dashboard',
        '/admin',
        [],
        new Map([['old-dashboard', 'native-flow-page']]),
      ),
    ).toBe('/admin/old-dashboard');
  });

  it('prefers a current alias assignment and native route identity over historical aliases', () => {
    const previousAliases = new Map([['old-dashboard', 'native-flow-page']]);
    const reassignedRoutes = [
      {
        id: 'sales-route',
        type: 'flowPage',
        schemaUid: 'native-flow-page',
        options: { pathAlias: 'sales-dashboard' },
      },
      {
        id: 'other-route',
        type: 'flowPage',
        schemaUid: 'other-page',
        options: { pathAlias: 'old-dashboard' },
      },
    ] as unknown as NocoBaseDesktopRoute[];
    expect(resolveAliasPathnameToSchemaUid('/admin/old-dashboard', '/admin', reassignedRoutes, previousAliases)).toBe(
      '/admin/other-page',
    );

    const nativeUidRoutes = [
      {
        id: 'sales-route',
        type: 'flowPage',
        schemaUid: 'native-flow-page',
        options: { pathAlias: 'sales-dashboard' },
      },
      { id: 'old-dashboard', type: 'flowPage', schemaUid: 'old-dashboard' },
    ] as unknown as NocoBaseDesktopRoute[];
    expect(resolveAliasPathnameToSchemaUid('/admin/old-dashboard', '/admin', nativeUidRoutes, previousAliases)).toBe(
      '/admin/old-dashboard',
    );

    const groupIdRoutes = [
      {
        id: 'sales-route',
        type: 'flowPage',
        schemaUid: 'native-flow-page',
        options: { pathAlias: 'sales-dashboard' },
      },
      { id: 'old-dashboard', type: 'group', children: [] },
    ] as unknown as NocoBaseDesktopRoute[];
    expect(resolveAliasPathnameToSchemaUid('/admin/old-dashboard', '/admin', groupIdRoutes, previousAliases)).toBe(
      '/admin/old-dashboard',
    );
  });

  describe('AdminLayoutModel resolution', () => {
    let engine: FlowEngine;

    beforeEach(() => {
      engine = new FlowEngine();
      engine.registerModels({ AdminLayoutModel: AliasAwareAdminLayoutModel });
    });

    it('resolves the slug through the same layout parser used by LayoutContentRoute', () => {
      engine.context.defineProperty('routeRepository', {
        value: {
          listAccessible: () => [...accessibleRoutes],
          getRouteBySchemaUid: () => undefined,
          getRouteById: () => undefined,
        },
      });

      const model = engine.createModel<AliasAwareAdminLayoutModel>({
        uid: 'admin-layout-model',
        use: 'AdminLayoutModel',
        props: {
          layout: {
            routeName: 'admin',
            routePath: '/admin',
            uid: 'admin-layout-model',
          },
        },
      });

      expect(
        model.resolveLayoutRoute({
          layoutRouteName: 'admin',
          layoutBasePathname: '/admin',
          pathname: '/admin/sales-dashboard/tab/detail/view/modal/tab/modal-tab/filterbytk/123',
          params: { name: 'sales-dashboard', tabUid: 'detail' },
        }),
      ).toMatchObject({
        type: 'page',
        pageUid: 'native-flow-page',
        tabUid: 'detail',
        viewStack: [
          { viewUid: 'native-flow-page', tabUid: 'detail' },
          { viewUid: 'modal', tabUid: 'modal-tab', filterByTk: '123' },
        ],
      });
    });

    it('leaves an inaccessible slug unresolved', () => {
      engine.context.defineProperty('routeRepository', {
        value: {
          listAccessible: () => [],
          getRouteBySchemaUid: () => undefined,
          getRouteById: () => undefined,
        },
      });

      const model = engine.createModel<AliasAwareAdminLayoutModel>({
        uid: 'admin-layout-model',
        use: 'AdminLayoutModel',
        props: {
          layout: {
            routeName: 'admin',
            routePath: '/admin',
            uid: 'admin-layout-model',
          },
        },
      });

      expect(
        model.resolveLayoutRoute({
          layoutRouteName: 'admin',
          layoutBasePathname: '/admin',
          pathname: '/admin/sales-dashboard',
          params: { name: 'sales-dashboard' },
        }),
      ).toMatchObject({ type: 'page', pageUid: 'sales-dashboard' });
    });
  });
});
