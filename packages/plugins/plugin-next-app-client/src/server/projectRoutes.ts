/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export interface ProjectedRoute {
  id?: string | number;
  schemaUid?: string;
  type?: string;
  children?: ProjectedRoute[];
  title?: string;
  tooltip?: string;
  icon?: string;
  sort?: number;
  hideInMenu?: boolean;
  nextAppRouteId?: string | number;
  [key: string]: unknown;
}

/** Both inputs have already been filtered by their own role permissions. */
export function projectHubRoutes(hubRoutes: ProjectedRoute[], desktopRoutes: ProjectedRoute[]): ProjectedRoute[] {
  const desktopByUid = new Map<string, ProjectedRoute>();
  const index = (routes: ProjectedRoute[]) => {
    for (const route of routes) {
      if (route.schemaUid) desktopByUid.set(route.schemaUid, route);
      index(route.children || []);
    }
  };
  index(desktopRoutes);
  return hubRoutes.flatMap((hub) => {
    if (hub.type === 'group') return [{ ...hub, children: projectHubRoutes(hub.children || [], desktopRoutes) }];
    if (hub.type === 'link') return [{ ...hub }];
    const desktop = hub.schemaUid && desktopByUid.get(hub.schemaUid);
    if (!desktop) return [];
    return [
      {
        ...desktop,
        title: hub.title || desktop.title,
        tooltip: hub.tooltip || desktop.tooltip,
        icon: hub.icon || desktop.icon,
        sort: hub.sort ?? desktop.sort,
        hideInMenu: hub.hideInMenu ?? desktop.hideInMenu,
        nextAppRouteId: hub.id,
      },
    ];
  });
}
