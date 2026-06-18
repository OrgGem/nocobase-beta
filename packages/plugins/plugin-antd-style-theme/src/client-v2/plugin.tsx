import { Plugin, Application } from '@nocobase/client-v2';
import React from 'react';

export class PluginAntdStyleThemeClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'antd-style-theme',
      title: this.t('Antd Style Theme'),
      icon: 'BgColorsOutlined',
      aclSnippet: 'pm.antd-style-theme.themes',
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'antd-style-theme',
      key: 'index',
      title: this.t('Antd Style Theme'),

      componentLoader: () => import('../client/components/ThemeListPage'),
    });
  }
}

export default PluginAntdStyleThemeClient;
