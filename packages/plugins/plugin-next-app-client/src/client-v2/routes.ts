/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export type RouteId = string | number;
export interface HubRoute {
  id?: RouteId;
  parentId?: RouteId;
  configId?: RouteId | null;
  nextAppRouteId?: RouteId;
  schemaUid?: string;
  title?: string;
  tooltip?: string;
  icon?: string;
  type?: string;
  sort?: number;
  hidden?: boolean;
  hideInMenu?: boolean;
  enableTabs?: boolean;
  children?: HubRoute[];
  options?: { url?: string; openInNewWindow?: boolean; [key: string]: unknown };
}

export function flattenRoutes(routes: HubRoute[]): HubRoute[] {
  return routes.flatMap((route) => [route, ...flattenRoutes(route.children || [])]);
}

export function findLandingRoute(routes: HubRoute[]): HubRoute | undefined {
  for (const route of routes) {
    if (route.hidden || route.hideInMenu) continue;
    if (route.type === 'flowPage' && route.schemaUid) return route;
    if (route.type === 'group') {
      const nested = findLandingRoute(route.children || []);
      if (nested) return nested;
    }
  }
}

export function hubPath(appPath: string, pageUid = '') {
  return `/hub/${encodeURIComponent(appPath)}${pageUid ? '/' + encodeURIComponent(pageUid) : ''}`;
}

export function hubLink(url: string, appPath: string): string | undefined {
  const link = url.trim();
  if (/^(https?:\/\/|mailto:|tel:)/i.test(link)) return link;
  if (/^[a-z][\w+.-]*:/i.test(link) || link.startsWith('//') || link.includes('\\')) return undefined;
  if (link.startsWith('/hub/')) return link;
  const suffix = link.replace(/^\/?admin(?:\/|$)/, '').replace(/^\/+/, '');
  return `${hubPath(appPath)}${suffix ? '/' + suffix : ''}`;
}

/** Keep IDs as received: snowflake primary keys may exceed JavaScript's safe integer range. */
export function permissionIds(routes: HubRoute[], id: RouteId, selected: RouteId[], checked: boolean): RouteId[] {
  const all = flattenRoutes(routes);
  const byId = new Map(all.map((route) => [String(route.id), route]));
  const next = new Map(selected.map((value) => [String(value), value]));
  const route = byId.get(String(id));
  if (!route) return selected;
  for (const item of flattenRoutes([route])) {
    if (item.id == null) continue;
    if (checked) next.set(String(item.id), item.id);
    else next.delete(String(item.id));
  }
  let parent = route.parentId == null ? undefined : byId.get(String(route.parentId));
  const seen = new Set<string>();
  while (parent?.id != null && !seen.has(String(parent.id))) {
    seen.add(String(parent.id));
    const hasSelectedChild = (parent.children || []).some((child) => child.id != null && next.has(String(child.id)));
    if (checked || hasSelectedChild) next.set(String(parent.id), parent.id);
    else next.delete(String(parent.id));
    parent = parent.parentId == null ? undefined : byId.get(String(parent.parentId));
  }
  return [...next.values()];
}
