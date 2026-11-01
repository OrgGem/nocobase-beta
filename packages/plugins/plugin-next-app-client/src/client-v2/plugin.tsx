/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin, Application } from '@nocobase/client-v2';
import type PluginACLClient from '@nocobase/plugin-acl/client-v2';
import {
  HubLegacyRedirect,
  HubTabsRedirect,
  NextAppLayoutModel,
  NextAppRuntime,
  HUB_LAYOUT_UID,
} from './NextAppRuntime';

export class PluginNextAppClientClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.flowEngine.registerModels({ NextAppLayoutModel });
    this.app.layoutManager.registerLayout({
      routeName: 'hub',
      routePath: '/hub/:appPath',
      uid: HUB_LAYOUT_UID,
      layoutModelClass: 'NextAppLayoutModel',
      authCheck: true,
    });
    this.app.router.add('hub', { path: '/hub/:appPath', Component: NextAppRuntime, authCheck: true });
    this.app.router.add('hub.legacy-tabs', { path: ':name/tabs/:tabUid', Component: HubTabsRedirect, authCheck: true });
    this.app.router.add('next-app-legacy-redirect', {
      path: '/next-app/*',
      Component: HubLegacyRedirect,
      authCheck: true,
    });
    this.pluginSettingsManager.addMenuItem({
      key: 'next-app-routes',
      title: this.t('Next App routes'),
      icon: 'AppstoreOutlined',
      aclSnippet: 'pm.nextApp',
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'next-app-routes',
      key: 'index',
      title: this.t('Next App routes'),
      aclSnippet: 'pm.nextApp',
      componentLoader: () => import('./NextAppSettings'),
    });
    this.app.pm.get<PluginACLClient>('acl')?.settingsUI.addPermissionsTab(({ currentUserRole }) => {
      const snippets = currentUserRole?.snippets || [];
      if (
        currentUserRole &&
        (!snippets.some((value) => ['pm.nextApp', 'pm.*', '*'].includes(value)) || snippets.includes('!pm.nextApp'))
      )
        return null;
      return {
        key: 'next-app-menu',
        label: String(this.t('Next App routes')),
        sort: 26,
        componentLoader: () => import('./MenuPermissions'),
      };
    });
  }
}

export default PluginNextAppClientClient;
