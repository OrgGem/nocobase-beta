// SPDX-License-Identifier: Apache-2.0

import { Plugin } from '@nocobase/client';
import React from 'react';
import { SettingsSearchInjector } from '../shared/SettingsSearchInjector';
import { HelpVisibilityProvider } from './HelpVisibilityProvider';
import { HelpSettingsPage } from './HelpSettingsPage';

export class PluginAdvanceSettingsClient extends Plugin<{ name?: string }> {
  async load() {
    this.app.use(HelpVisibilityProvider);
    this.app.use(SettingsSearchInjector);

    this.app.pluginSettingsManager.add('advance-settings', {
      title: this.t('Advance Settings'),
      icon: 'SettingOutlined',
      Component: HelpSettingsPage,
      aclSnippet: `pm.${this.options?.name || 'plugin-advance-settings'}`,
      sort: 1000,
    });
  }
}

export default PluginAdvanceSettingsClient;
