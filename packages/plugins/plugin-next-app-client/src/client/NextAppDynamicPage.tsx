/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * NextAppDynamicPage — renders page content using RemoteSchemaComponent.
 * Similar to AdminDynamicPage but works within our separate sub-router.
 *
 * Uses KeepAlive to preserve page state (scroll position, filters, form state)
 * when navigating between pages — same pattern as admin-layout.
 */
import React, { memo, useEffect, useMemo } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { RemoteSchemaComponent, KeepAlive } from '@nocobase/client';
import { NocoBaseDesktopRouteType } from '@nocobase/client';
import { type LayoutDefinition } from '@nocobase/client-v2';
import { FlowModelRenderer, useFlowEngine } from '@nocobase/flow-engine';
import { NextAppDesktopRoute, useNextAppAllAccessRoutes } from './nextAppRoutesContext';
import {
  getNextAppLayoutModel,
  NEXT_APP_LAYOUT_MODEL_CLASS,
  NEXT_APP_LAYOUT_MODEL_UID,
  NextAppLayoutModel,
} from './NextAppFlowLayoutModel';
import { HUB_PATH, HUB_ROUTE_NAMES } from './hubRouteContract';

const NEXT_APP_LAYOUT_DEFINITION: LayoutDefinition = {
  routeName: HUB_ROUTE_NAMES.root,
  rootRouteName: HUB_ROUTE_NAMES.root,
  routePath: HUB_PATH,
  uid: NEXT_APP_LAYOUT_MODEL_UID,
  layoutModelClass: NEXT_APP_LAYOUT_MODEL_CLASS,
  rootPageModelClass: 'RootPageModel',
  childPageModelClass: 'ChildPageModel',
  authCheck: true,
};

const findRouteBySchemaUid = (uid: string, routes: NextAppDesktopRoute[]): NextAppDesktopRoute | undefined => {
  if (!routes) return null;
  for (const route of routes) {
    if (route.schemaUid === uid) return route;
    if (route.children?.length) {
      const found = findRouteBySchemaUid(uid, route.children);
      if (found) return found;
    }
  }
  return undefined;
};

const isGroup = (groupId: string, allAccessRoutes: NextAppDesktopRoute[]) => {
  const route = findRouteById(groupId, allAccessRoutes);
  return route?.type === NocoBaseDesktopRouteType.group;
};

const findRouteById = (id: string, treeArray: NextAppDesktopRoute[]): NextAppDesktopRoute | undefined => {
  for (const node of treeArray) {
    if (Number(id) === Number(node.id)) return node;
    if (node.children?.length) {
      const result = findRouteById(id, node.children);
      if (result) return result;
    }
  }
  return undefined;
};

const noAccessPermission = (currentPageUid: string, allAccessRoutes: NextAppDesktopRoute[]) => {
  if (!currentPageUid) return false;
  const routeNode = findRouteBySchemaUid(currentPageUid, allAccessRoutes);
  return !routeNode;
};

const NextAppFlowPage = (props: { pageUid: string }) => {
  const { pageUid } = props;
  const { allAccessRoutes } = useNextAppAllAccessRoutes();
  const flowEngine = useFlowEngine();
  const location = useLocation();
  const params = useParams<{ appPath?: string; name?: string; tabUid?: string; '*': string }>();
  const model = getNextAppLayoutModel<NextAppLayoutModel>(flowEngine, {
    create: true,
    props: {
      layout: NEXT_APP_LAYOUT_DEFINITION,
      pageUid,
    },
    use: NextAppLayoutModel,
  });
  const routeLike = useMemo(
    () => ({
      id: params.tabUid ? HUB_ROUTE_NAMES.tabs : HUB_ROUTE_NAMES.page,
      name: params.tabUid ? HUB_ROUTE_NAMES.tabs : HUB_ROUTE_NAMES.page,
      pathname: typeof window !== 'undefined' ? window.location.pathname : location.pathname,
      params,
      layoutRouteName: NEXT_APP_LAYOUT_DEFINITION.routeName,
      layoutBasePathname: `${NEXT_APP_LAYOUT_DEFINITION.routePath}/${params.appPath || ''}`,
    }),
    [location.pathname, params],
  );
  const layoutRoute = useMemo(() => model.resolveLayoutRoute(routeLike), [model, routeLike]);
  model.setProps({
    layout: NEXT_APP_LAYOUT_DEFINITION,
    pageUid: layoutRoute.type === 'page' ? layoutRoute.pageUid || pageUid : '',
  });
  model.syncLayoutRoute(routeLike);

  useEffect(() => {
    if (layoutRoute.type !== 'page') {
      return;
    }

    const currentPageUid = layoutRoute.pageUid || pageUid;
    model.registerRoutePage(currentPageUid, {
      active: true,
      refreshDesktopRoutes: () => Promise.resolve(allAccessRoutes),
      layoutContentElement: null,
    });
    model.syncLayoutRoute(routeLike);

    return () => {
      model.unregisterRoutePage(currentPageUid);
    };
  }, [allAccessRoutes, layoutRoute, model, pageUid, routeLike]);

  return <FlowModelRenderer model={model} />;
};

export const NextAppDynamicPage = memo(() => {
  const params = useParams<{ name?: string }>();
  const currentPageUid = params.name || '';
  const { allAccessRoutes } = useNextAppAllAccessRoutes();

  // Group page should not request schema data
  if (isGroup(currentPageUid, allAccessRoutes)) {
    return null;
  }

  // 404 - no access
  if (noAccessPermission(currentPageUid, allAccessRoutes)) {
    return (
      <div style={{ textAlign: 'center', padding: '100px 0' }}>
        <h2>404</h2>
        <p>Sorry, the page you visited does not exist.</p>
      </div>
    );
  }

  if (!currentPageUid) {
    return null;
  }

  return (
    <KeepAlive uid={currentPageUid}>
      {(uid: string) => {
        const route = findRouteBySchemaUid(uid, allAccessRoutes);
        if (route?.type === NocoBaseDesktopRouteType.flowPage) {
          return <NextAppFlowPage pageUid={uid} />;
        }
        return <RemoteSchemaComponent uid={uid} />;
      }}
    </KeepAlive>
  );
});

NextAppDynamicPage.displayName = 'NextAppDynamicPage';
export default NextAppDynamicPage;
