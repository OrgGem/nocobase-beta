import { Plugin, Application } from '@nocobase/client-v2';
import React from 'react';

export class PluginDocpixieClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'plugin-docpixie',
      title: this.t('DocPixie Document AI'),
      icon: 'FileSearchOutlined',
      
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'plugin-docpixie',
      key: 'index',
      title: this.t('DocPixie Document AI'),
      
      componentLoader: () => import('../client/index').then(m => ({ default: m.DocPixieSettings })),
    });

  }
}

export default PluginDocpixieClient;
