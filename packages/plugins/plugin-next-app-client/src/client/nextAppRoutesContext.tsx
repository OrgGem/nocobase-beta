/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * NextApp route context — provides nextAppRoutes data to the NextApp scope.
 *
 * This mirrors how the core `AllAccessDesktopRoutesContext` works, but is specific
 * to the NextApp sub-router, fetching from `nextAppRoutes:listAccessible` instead
 * of `desktopRoutes:listAccessible`.
 *
 * Also syncs routes into FlowEngine's routeRepository so that schema editing
 * (page references, flow actions) works correctly within the NextApp scope.
 */
import React, { createContext, FC, useContext, useEffect, useMemo, useRef } from 'react';
import { useRequest, NocoBaseDesktopRouteType } from '@nocobase/client';
import { useFlowEngineContext } from '@nocobase/flow-engine';
import { useParams } from 'react-router-dom';

export interface NextAppDesktopRoute {
  id: number;
  schemaUid?: string;
  menuSchemaUid?: string;
  tabSchemaName?: string;
  type?: NocoBaseDesktopRouteType;
  options?: any;
  title?: string;
  tooltip?: string;
  icon?: string;
  parentId?: number;
  children?: NextAppDesktopRoute[];
  hideInMenu?: boolean;
  enableTabs?: boolean;
  enableHeader?: boolean;
  displayTitle?: boolean;
  hidden?: boolean;
}

const emptyArray: NextAppDesktopRoute[] = [];

const NextAppAllAccessRoutesContext = createContext<{
  allAccessRoutes: NextAppDesktopRoute[];
  refresh: () => void;
}>({
  allAccessRoutes: emptyArray,
  refresh: () => {},
});
NextAppAllAccessRoutesContext.displayName = 'NextAppAllAccessRoutesContext';

/**
 * Hook to get all accessible nextApp routes.
 * Drop-in replacement for `useAllAccessDesktopRoutes` within the NextApp scope.
 */
export const useNextAppAllAccessRoutes = () => {
  return useContext(NextAppAllAccessRoutesContext);
};

/**
 * Provider that fetches nextAppRoutes:listAccessible and provides
 * the data via context. Similar to the core RoutesRequestProvider
 * but for nextAppRoutes.
 *
 * Also syncs routes into FlowEngine routeRepository for schema editing support.
 */
export const NextAppRoutesRequestProvider: FC = ({ children }) => {
  const mountedRef = useRef(false);
  const ctx = useFlowEngineContext();
  const appPathRef = useRef<string | undefined>();

  const { appPath } = useParams();
  appPathRef.current = appPath;
  const { data, refresh, loading } = useRequest<any>(
    {
      url: `/nextAppRoutes:listAccessible`,
      params: {
        tree: true,
        sort: 'sort',
        filter: {
          appPath,
        },
      },
    },
    {
      onSuccess(data) {
        if (ctx?.routeRepository) {
          ctx.routeRepository.setRoutes(data?.data || emptyArray);
        }
      },
    },
  );

  const allAccessRoutesValue = useMemo(() => {
    return {
      allAccessRoutes: data?.data || emptyArray,
      refresh,
    };
  }, [data?.data, refresh]);

  useEffect(() => {
    const routeRepository = ctx?.routeRepository;

    if (!routeRepository || typeof routeRepository.refreshAccessible !== 'function') {
      return;
    }

    const originalRefreshAccessible = routeRepository.refreshAccessible.bind(routeRepository);
    routeRepository.refreshAccessible = async () => {
      const response = await ctx.api.request({
        url: `/nextAppRoutes:listAccessible`,
        params: {
          tree: true,
          sort: 'sort',
          filter: {
            appPath: appPathRef.current,
          },
        },
      });
      const routes = response?.data?.data || emptyArray;
      routeRepository.setRoutes(routes);
      return routes;
    };

    return () => {
      routeRepository.refreshAccessible = originalRefreshAccessible;
    };
  }, [ctx]);

  // Only block on first load
  if (loading && !mountedRef.current) {
    return null;
  } else {
    mountedRef.current = true;
  }

  return (
    <NextAppAllAccessRoutesContext.Provider value={allAccessRoutesValue}>
      {children}
    </NextAppAllAccessRoutesContext.Provider>
  );
};
