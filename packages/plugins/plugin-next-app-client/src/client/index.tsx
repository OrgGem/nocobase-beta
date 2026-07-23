/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { PagePopups, Plugin, createRouterManager, RouterManager, lazy } from '@nocobase/client';
import PluginACLClient from '@nocobase/plugin-acl/client';
import React from 'react';
import { Outlet } from 'react-router-dom';
import { MenuPermissions, NextAppAllRoutesProvider } from './MenuPermissions';
import { NextApp } from './NextApp';
import { NextAppLayout } from './NextAppLayout';
import { NextAppDynamicPage } from './NextAppDynamicPage';
import { HubLegacyRedirect } from './HubLegacyRedirect';
import { HubAdminRedirect } from './HubAdminRedirect';
import { HubRouteStore } from './HubRouteStore';
import { getHubBasename, HUB_PATH, HUB_ROUTE_NAMES, LEGACY_NEXT_APP_PATH } from './hubRouteContract';
import pkg from '../../package.json';

const { NextAppSettings } = lazy(() => import('./NextAppSettings'), 'NextAppSettings');

export class PluginNextAppClient extends Plugin {
  nextAppRouter?: RouterManager;
  readonly hubRouteStore = new HubRouteStore();
  nextAppPath = HUB_PATH;

  async beforeLoad() {}

  async load() {
    this.setupRouter();
    this.addComponents();
    this.addSettings();
    this.addPermissionsSettingsUI();
  }

  /**
   * Create (or recreate) the sub-router with the given path segment.
   */
  setupRouter() {
    this.nextAppPath = HUB_PATH;
    const basename = getHubBasename(this.router.getBasename() || '/');

    this.nextAppRouter = createRouterManager({ type: 'browser', basename }, this.app);

    this.addSubRoutes();

    // Re-register the catch-all in the main app router (remove old one first if exists)
    this.app.router.add(HUB_ROUTE_NAMES.root, {
      path: `${this.nextAppPath}/*`,
      Component: NextApp,
    });

    this.app.router.add('next-app-legacy-redirect', {
      path: `${LEGACY_NEXT_APP_PATH}/*`,
      Component: HubLegacyRedirect,
    });
  }

  /**
   * Register components globally
   */
  addComponents() {
    this.app.addComponents({
      NextApp,
      NextAppLayout,
      NextAppDynamicPage,
      HubLegacyRedirect,
      HubAdminRedirect,
    });
  }

  /**
   * Register routes inside the separate sub-router.
   * Paths are relative to the sub-router's basename (/hub).
   * Cấu trúc: /:appPath/[:pageName]
   */
  addSubRoutes() {
    const router = this.nextAppRouter;
    if (!router) {
      throw new Error('[plugin-next-app-client] Hub router is not initialized');
    }
    // Main layout
    router.add(HUB_ROUTE_NAMES.root, {
      path: '/:appPath',
      Component: 'NextAppLayout',
    });

    router.add('hub-admin-compat', {
      path: '/admin/*',
      Component: HubAdminRedirect,
    });

    // Dynamic page
    router.add(HUB_ROUTE_NAMES.page, {
      path: '/:appPath/:name',
      Component: 'NextAppDynamicPage',
    });

    // Tabs
    router.add(HUB_ROUTE_NAMES.tabs, {
      path: '/:appPath/:name/tabs/:tabUid',
      Component: 'NextAppDynamicPage',
    });

    // Popups
    router.add(HUB_ROUTE_NAMES.popups, {
      path: '/:appPath/:name/popups/*',
      Component: PagePopups,
    });

    // Tabs + Popups
    router.add(HUB_ROUTE_NAMES.tabPopups, {
      path: '/:appPath/:name/tabs/:tabUid/popups/*',
      Component: PagePopups,
    });
  }

  /**
   * Get the RouterManager component for rendering.
   * Returns a stable component — call once and cache the result.
   */
  getRouterComponent() {
    if (!this.nextAppRouter) {
      throw new Error('[plugin-next-app-client] Hub router is not initialized');
    }
    return this.nextAppRouter.getRouterComponent();
  }

  /**
   * Register "Next App" settings into the Routes category
   */
  addSettings() {
    this.app.pluginSettingsManager.add('routes.next-apps', {
      title: 'Next App routes',
      icon: 'AppstoreOutlined',
      Component: NextAppSettings,
      aclSnippet: 'pm.nextApp',
      sort: 10,
    });
  }

  /**
   * Add "Next App routes" tab to ACL permissions settings
   */
  addPermissionsSettingsUI() {
    this.app.pm.get(PluginACLClient)?.settingsUI.addPermissionsTab(({ t, TabLayout, activeKey, currentUserRole }) => {
      if (
        currentUserRole &&
        ((!currentUserRole.snippets.includes('pm.nextApp') && !currentUserRole.snippets.includes('pm.*')) ||
          currentUserRole.snippets.includes('!pm.nextApp'))
      ) {
        return null;
      }

      return {
        key: 'next-app-menu',
        label: t('Next App routes', {
          ns: pkg.name,
        }),
        sort: 26,
        children: (
          <TabLayout>
            <NextAppAllRoutesProvider active={activeKey === 'next-app-menu'}>
              <MenuPermissions active={activeKey === 'next-app-menu'} />
            </NextAppAllRoutesProvider>
          </TabLayout>
        ),
      };
    });
  }
}

export default PluginNextAppClient;
