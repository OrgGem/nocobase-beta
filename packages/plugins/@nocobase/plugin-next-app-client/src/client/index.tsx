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
// @ts-ignore
import pkg from '../../package.json';

const { NextAppSettings } = lazy(() => import('./NextAppSettings'), 'NextAppSettings');

export class PluginNextAppClient extends Plugin {
  nextAppRouter?: RouterManager;
  nextAppPath = '/apps';

  async afterAdd() {
    // Set up sub-router synchronously with default path.
    // If a configured path is found in load(), setupRouter() is called again.
    this.setupRouter();
  }

  async beforeLoad() {}

  async load() {
    this.addComponents();
    this.addSettings();
    this.addPermissionsSettingsUI();
  }

  /**
   * Create (or recreate) the sub-router with the given path segment.
   * Synchronous — safe to call from afterAdd().
   */
  setupRouter(pathSegment = 'apps') {
    this.nextAppPath = `/${pathSegment.replace(/^\//, '')}`;
    const segment = this.nextAppPath.replace(/^\//, '');
    const basename = `${this.router.getBasename()}${segment}`;

    this.nextAppRouter = createRouterManager({ type: 'browser', basename }, this.app);

    this.addSubRoutes();

    // Re-register the catch-all in the main app router (remove old one first if exists)
    this.app.router.add('next-app', {
      path: `${this.nextAppPath}/*`,
      Component: 'NextApp',
    });

    console.log(`[plugin-next-app] Router set up at ${this.nextAppPath}`);
  }

  /**
   * Register components globally
   */
  addComponents() {
    this.app.addComponents({
      NextApp,
      NextAppLayout,
      NextAppDynamicPage,
    });
  }

  /**
   * Register routes inside the separate sub-router.
   * Paths are relative to the sub-router's basename (/apps).
   * Cấu trúc: /:appPath/[:pageName]
   */
  addSubRoutes() {
    // Main layout
    this.nextAppRouter!.add('nextApp', {
      path: '/:appPath',
      Component: 'NextAppLayout',
    });

    // Dynamic page
    this.nextAppRouter!.add('nextApp.page', {
      path: '/:appPath/:name',
      Component: 'NextAppDynamicPage',
    });

    // Tabs
    this.nextAppRouter!.add('nextApp.page.tabs', {
      path: '/:appPath/:name/tabs/:tabUid',
      Component: 'NextAppDynamicPage',
    });

    // Popups
    this.nextAppRouter!.add('nextApp.page.popups', {
      path: '/:appPath/:name/popups/*',
      Component: PagePopups,
    });

    // Tabs + Popups
    this.nextAppRouter!.add('nextApp.page.tabs.popups', {
      path: '/:appPath/:name/tabs/:tabUid/popups/*',
      Component: PagePopups,
    });
  }

  /**
   * Get the RouterManager component for rendering.
   * Returns a stable component — call once and cache the result.
   */
  getRouterComponent() {
    return this.nextAppRouter!.getRouterComponent();
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
