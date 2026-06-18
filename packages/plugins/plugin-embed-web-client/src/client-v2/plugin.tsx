import { Plugin, Application } from '@nocobase/client-v2';
import React from 'react';

export class PluginEmbedWebClientClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'embed-web-client',
      title: this.t('Web Client Embedding'),
      icon: 'ThunderboltOutlined',
      
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'embed-web-client',
      key: 'models',
      title: this.t('Models'),
      
      componentLoader: () => import('../client/components/ModelManager').then(m => ({ default: m.ModelManager })),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'embed-web-client',
      key: 'settings',
      title: this.t('Settings'),
      
      componentLoader: () => import('../client/components/PluginSettings').then(m => ({ default: m.PluginSettings })),
    });

  }
}

export default PluginEmbedWebClientClient;
