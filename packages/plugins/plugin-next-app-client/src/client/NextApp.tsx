/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * NextApp — mount component for the separate sub-router.
 *
 * Instead of using AdminProvider (which fetches desktopRoutes and redirects to /admin),
 * we build a custom provider stack that:
 * 1. Fetches nextAppRoutes:listAccessible via NextAppRoutesRequestProvider
 * 2. Provides schema/collection infrastructure for rendering pages
 *
 * Uses usePlugin() for reliable plugin lookup (same pattern as Mobile.tsx).
 */
import React, { useMemo } from 'react';
import {
  ACLRolesCheckProvider,
  CurrentAppInfoProvider,
  RemoteCollectionManagerProvider,
  RemoteSchemaTemplateManagerProvider,
  usePlugin,
} from '@nocobase/client';
import { CurrentPageUidProvider, CurrentTabUidProvider, IsSubPageClosedByPageMenuProvider } from '@nocobase/client';
import { NextAppRoutesRequestProvider } from './nextAppRoutesContext';
import { PluginNextAppClient } from './index';

export const NextApp = () => {
  const plugin = usePlugin(PluginNextAppClient);

  // Cache the router component — getRouterComponent() creates a new component
  // function each call, so calling it on every render causes React to unmount/remount.
  const NextAppRouter = useMemo(() => {
    if (!plugin?.nextAppRouter) return null;
    return plugin.nextAppRouter.getRouterComponent();
  }, [plugin?.nextAppRouter]);

  if (!NextAppRouter) {
    console.error('[NextApp] Plugin next-app-client not found or router not initialized');
    return null;
  }

  return (
    <CurrentPageUidProvider>
      <CurrentTabUidProvider>
        <IsSubPageClosedByPageMenuProvider>
          <ACLRolesCheckProvider>
            <RemoteCollectionManagerProvider>
              <CurrentAppInfoProvider>
                <RemoteSchemaTemplateManagerProvider>
                  <NextAppRouter />
                </RemoteSchemaTemplateManagerProvider>
              </CurrentAppInfoProvider>
            </RemoteCollectionManagerProvider>
          </ACLRolesCheckProvider>
        </IsSubPageClosedByPageMenuProvider>
      </CurrentTabUidProvider>
    </CurrentPageUidProvider>
  );
};

export default NextApp;
