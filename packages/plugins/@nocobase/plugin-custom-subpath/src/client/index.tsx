/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin, lazy } from '@nocobase/client';
import { tval } from '@nocobase/utils/client';

const { SubpathSettings } = lazy(() => import('./SubpathSettings'), 'SubpathSettings');

export class PluginCustomSubpathClient extends Plugin {
  async afterAdd() {}

  async beforeLoad() {}

  async load() {
    // Register plugin settings page
    this.app.pluginSettingsManager.add('custom-subpath', {
      title: tval('Custom Subpath', { ns: '@nocobase/plugin-custom-subpath' }),
      icon: 'LinkOutlined',
      Component: SubpathSettings,
      aclSnippet: `pm.${this.name}.custom-subpaths`,
    });

    // Register client-side routes for all enabled custom subpaths
    await this.registerSubpathRoutes();
  }

  /**
   * Fetches enabled subpaths from the server and registers React Router routes
   * mirroring the /admin route structure for each custom subpath.
   *
   * NocoBase's Gateway already serves index.html for any non-API path,
   * so we only need to register client-side routes.
   */
  private async registerSubpathRoutes() {
    try {
      const response = await this.app.apiClient.request({
        url: 'customSubpaths:list',
        params: {
          filter: { enabled: true },
          pageSize: 100,
        },
      });

      const subpaths: Array<{ path: string; title?: string }> = (response as any)?.data?.data || [];

      for (const subpath of subpaths) {
        const p = subpath.path;
        if (!p) continue;

        // Mirror all /admin routes from NocoBaseBuildInPlugin.addRoutes()
        // See: packages/core/client/src/nocobase-buildin-plugin/index.tsx

        // Main layout
        this.router.add(`custom-subpath-${p}`, {
          path: `/${p}`,
          Component: 'AdminLayout',
        });

        // Dynamic page
        this.router.add(`custom-subpath-${p}.page`, {
          path: `/${p}/:name`,
          Component: 'AdminDynamicPage',
        });

        // Tabs
        this.router.add(`custom-subpath-${p}.page.tabs`, {
          path: `/${p}/:name/tabs/:tabUid`,
          Component: 'PageTabs',
        });

        // Popups
        this.router.add(`custom-subpath-${p}.page.popups`, {
          path: `/${p}/:name/popups/*`,
          Component: 'PagePopups',
        });

        // Tabs + Popups
        this.router.add(`custom-subpath-${p}.page.tabs.popups`, {
          path: `/${p}/:name/tabs/:tabUid/popups/*`,
          Component: 'PagePopups',
        });

        // 2.0 compatibility routes
        this.router.add(`custom-subpath-${p}.page.tab`, {
          path: `/${p}/:name/tab/:tabUid`,
          Component: 'AdminDynamicPage',
        });

        this.router.add(`custom-subpath-${p}.page.view`, {
          path: `/${p}/:name/view/*`,
          Component: 'AdminDynamicPage',
        });

        this.router.add(`custom-subpath-${p}.page.tab.view`, {
          path: `/${p}/:name/tab/:tabUid/view/*`,
          Component: 'AdminDynamicPage',
        });
      }
    } catch (err: any) {
      console.warn('[plugin-custom-subpath] Could not load subpaths:', err?.message || err);
    }
  }
}

export default PluginCustomSubpathClient;
