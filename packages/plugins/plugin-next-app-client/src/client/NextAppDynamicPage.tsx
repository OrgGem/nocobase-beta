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
import React, { memo } from 'react';
import { useParams } from 'react-router-dom';
import { RemoteSchemaComponent, KeepAlive } from '@nocobase/client';
import { NocoBaseDesktopRouteType } from '@nocobase/client';
import { useNextAppAllAccessRoutes } from './nextAppRoutesContext';

const findRouteBySchemaUid = (uid: string, routes: any[]): any => {
  if (!routes) return null;
  for (const route of routes) {
    if (route.schemaUid === uid) return route;
    if (route.children?.length) {
      const found = findRouteBySchemaUid(uid, route.children);
      if (found) return found;
    }
  }
  return null;
};

const isGroup = (groupId: string, allAccessRoutes: any[]) => {
  const route = findRouteById(groupId, allAccessRoutes);
  return route?.type === NocoBaseDesktopRouteType.group;
};

const findRouteById = (id: string, treeArray: any[]): any => {
  for (const node of treeArray) {
    if (Number(id) === Number(node.id)) return node;
    if (node.children?.length) {
      const result = findRouteById(id, node.children);
      if (result) return result;
    }
  }
  return null;
};

const noAccessPermission = (currentPageUid: string, allAccessRoutes: any[]) => {
  if (!currentPageUid) return false;
  const routeNode = findRouteBySchemaUid(currentPageUid, allAccessRoutes);
  return !routeNode;
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

  return <KeepAlive uid={currentPageUid}>{(uid) => <RemoteSchemaComponent uid={uid} />}</KeepAlive>;
});

NextAppDynamicPage.displayName = 'NextAppDynamicPage';
export default NextAppDynamicPage;
