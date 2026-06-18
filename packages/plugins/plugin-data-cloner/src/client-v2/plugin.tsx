import { Plugin, Application } from '@nocobase/client-v2';
import React from 'react';

export class PluginDataClonerClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'data-cloner',
      title: this.t('Data Cloner'),
      icon: 'DatabaseOutlined',
      
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'data-cloner',
      key: 'index',
      title: this.t('Data Cloner'),
      
      componentLoader: () => import('../client/ClonerManager').then(m => ({ default: m.ClonerManager })),
    });

  }
}

export default PluginDataClonerClient;
