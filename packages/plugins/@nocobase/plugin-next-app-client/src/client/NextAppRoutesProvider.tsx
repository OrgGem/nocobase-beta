/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { APIClient, LOADING_DELAY, useAPIClient, useRequest } from '@nocobase/client';
import { Spin } from 'antd';
import React, { createContext, FC, useContext, useMemo } from 'react';

import type { IResource } from '@nocobase/sdk';

export interface NextAppRouteItem {
  id: number;
  schemaUid?: string;
  menuSchemaUid?: string;
  tabSchemaName?: string;
  type?: string;
  options?: any;
  title?: string;
  tooltip?: string;
  icon?: string;
  parentId?: number;
  children?: NextAppRouteItem[];
  hideInMenu?: boolean;
  enableTabs?: boolean;
  enableHeader?: boolean;
  displayTitle?: boolean;
  hidden?: boolean;
}

export interface NextAppRoutesContextValue {
  routeList?: NextAppRouteItem[];
  refresh: () => Promise<any>;
  resource: IResource;
  schemaResource: IResource;
  api: APIClient;
}

export const NextAppRoutesContext = createContext<NextAppRoutesContextValue>(null);
NextAppRoutesContext.displayName = 'NextAppRoutesContext';

export const useNextAppRoutes = () => {
  return useContext(NextAppRoutesContext);
};

export const NextAppRoutesProvider: FC<{
  /**
   * list: return all route data, and only administrators can access;
   * listAccessible: return the route data that the current user can access;
   *
   * @default 'listAccessible'
   */
  action?: 'list' | 'listAccessible';
  configId?: number;
  refreshRef?: any;
  manual?: boolean;
}> = ({ children, refreshRef, manual, configId, action = 'listAccessible' }) => {
  const api = useAPIClient();
  const resource = useMemo(() => api.resource('nextAppRoutes'), [api]);
  const schemaResource = useMemo(() => api.resource('uiSchemas'), [api]);
  const {
    data,
    runAsync: refresh,
    loading,
  } = useRequest<{ data: NextAppRouteItem[] }>(
    () =>
      resource[action](
        action === 'listAccessible'
          ? {
              tree: true,
              sort: 'sort',
              paginate: false,
              filter: configId ? { configId } : undefined,
            }
          : {
              tree: true,
              sort: 'sort',
              paginate: false,
              filter: {
                hidden: { $ne: true },
                ...(configId ? { configId } : {}),
              },
            },
      ).then((res) => res.data),
    {
      manual,
    },
  );

  if (refreshRef) {
    refreshRef.current = refresh;
  }

  const routeList = useMemo(() => data?.data || [], [data]);

  const value = useMemo(
    () => ({ api, routeList, refresh, resource, schemaResource }),
    [api, refresh, resource, routeList, schemaResource],
  );

  if (loading) {
    return (
      <div style={{ textAlign: 'center', margin: '20px 0' }}>
        <Spin delay={LOADING_DELAY} />
      </div>
    );
  }

  return <NextAppRoutesContext.Provider value={value}>{children}</NextAppRoutesContext.Provider>;
};
