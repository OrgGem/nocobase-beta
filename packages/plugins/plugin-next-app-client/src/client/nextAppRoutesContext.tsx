import React, { FC, useCallback, useEffect, useRef } from 'react';
import { NocoBaseDesktopRouteType, usePlugin, useRequest } from '@nocobase/client';
import { useParams } from 'react-router-dom';
import { PluginNextAppClient } from './index';
import { useHubRouteStore } from './HubRouteStore';

export interface NextAppDesktopRouteOptions {
  url?: string;
  openInNewWindow?: boolean;
  [key: string]: unknown;
}

export interface NextAppDesktopRoute {
  id: number;
  schemaUid?: string;
  menuSchemaUid?: string;
  tabSchemaName?: string;
  type?: NocoBaseDesktopRouteType;
  options?: NextAppDesktopRouteOptions;
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

interface RoutesResponse {
  data?: NextAppDesktopRoute[];
}

const emptyRoutes: NextAppDesktopRoute[] = [];

export const useNextAppAllAccessRoutes = () => {
  const plugin = usePlugin(PluginNextAppClient);
  const allAccessRoutes = useHubRouteStore(plugin.hubRouteStore);
  return {
    allAccessRoutes,
    refresh: () => plugin.hubRouteStore.refresh(),
  };
};

/** Fetch boundary for the Hub route store. It does not mutate the global desktop route repository. */
export const NextAppRoutesRequestProvider: FC = ({ children }) => {
  const plugin = usePlugin(PluginNextAppClient);
  const mountedRef = useRef(false);
  const { appPath } = useParams<{ appPath: string }>();
  plugin.hubRouteStore.setAppPath(appPath || '');

  const requestRoutes = useCallback(async () => {
    const response = await plugin.app.apiClient.request<RoutesResponse>({
      url: '/nextAppRoutes:listAccessible',
      params: {
        tree: true,
        sort: 'sort',
        filter: { appPath },
      },
    });
    const routes = response?.data?.data || emptyRoutes;
    plugin.hubRouteStore.setRoutes(routes);
    return routes;
  }, [appPath, plugin]);

  const { loading } = useRequest(requestRoutes, {
    refreshDeps: [appPath],
  });

  useEffect(() => {
    plugin.hubRouteStore.setRefreshHandler(requestRoutes);
    return () => plugin.hubRouteStore.setRefreshHandler(undefined);
  }, [plugin, requestRoutes]);

  if (loading && !mountedRef.current) {
    return null;
  }
  mountedRef.current = true;
  return <>{children}</>;
};
