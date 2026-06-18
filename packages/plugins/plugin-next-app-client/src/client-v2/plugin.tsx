import { Plugin, Application } from '@nocobase/client-v2';
import React from 'react';

export class PluginNextAppClientClient extends Plugin<Record<string, never>, Application> {
  async load() {
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
      
      componentLoader: () => import('../client/NextAppSettings').then(m => ({ default: m.NextAppSettings })),
    });

  }
}

export default PluginNextAppClientClient;
