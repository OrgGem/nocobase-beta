import { Plugin } from '@nocobase/client';
import React from 'react';
import { SettingsSearchInjector } from './SettingsSearchInjector';
import { HelpVisibilityProvider } from './HelpVisibilityProvider';
import { HelpSettingsPage } from './HelpSettingsPage';

export class PluginAdvanceSettingsClient extends Plugin {
  async load() {
    this.app.use(SettingsSearchInjector);
    this.app.use(HelpVisibilityProvider);

    this.app.pluginSettingsManager.add('advance-settings', {
      title: this.t('Advance Settings'),
      icon: 'SettingOutlined',
      Component: HelpSettingsPage,
      aclSnippet: 'pm.plugin-advance-settings',
      sort: 1000,
    });
  }
}

export default PluginAdvanceSettingsClient;
