import { Plugin, Application } from '@nocobase/client-v2';
import React from 'react';

export class PluginSharedFormsClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'shared-forms',
      title: this.t('Shared forms'),
      icon: 'LockOutlined',
      
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'shared-forms',
      key: 'index',
      title: this.t('Shared forms'),
      
      componentLoader: () => import('../client/components/AdminSharedFormList').then(m => ({ default: m.AdminSharedFormList })),
    });

  }
}

export default PluginSharedFormsClient;
