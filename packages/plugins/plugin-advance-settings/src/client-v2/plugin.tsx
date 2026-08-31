import React from 'react';
import { Plugin, Application } from '@nocobase/client-v2';
import { HelpVisibilityProviderV2 } from './HelpVisibilityProvider';
import { HelpSettingsPage } from './HelpSettingsPage';

export class PluginAdvanceSettingsClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.app.use(HelpVisibilityProviderV2);

    this.pluginSettingsManager.addMenuItem({
      key: 'advance-settings',
      title: this.t('Advance Settings'),
      icon: 'SettingOutlined',
      aclSnippet: 'pm.plugin-advance-settings',
      sort: 1000,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'advance-settings',
      key: 'help',
      title: this.t('Help'),
      componentLoader: () => import('./HelpSettingsPage').then((m) => ({ default: m.HelpSettingsPage })),
      aclSnippet: 'pm.plugin-advance-settings',
    });

    // In v2, the search box is injected separately (see client/ component setup)
  }
}

export default PluginAdvanceSettingsClient;
