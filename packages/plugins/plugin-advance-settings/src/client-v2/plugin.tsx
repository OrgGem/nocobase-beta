// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { Plugin, Application } from '@nocobase/client-v2';
import { SettingsSearchInjector } from '../shared/SettingsSearchInjector';
import { HelpVisibilityProviderV2 } from './HelpVisibilityProvider';
import { HelpSettingsPage } from './HelpSettingsPage';

export class PluginAdvanceSettingsClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.app.use(HelpVisibilityProviderV2);
    this.app.use(SettingsSearchInjector);

    this.pluginSettingsManager.addMenuItem({
      key: 'advance-settings',
      title: this.t('Advance Settings'),
      icon: 'SettingOutlined',
      aclSnippet: `pm.${this.options.name || 'plugin-advance-settings'}`,
      sort: 1000,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'advance-settings',
      key: 'help',
      title: this.t('Help'),
      sort: 10,
      componentLoader: () => import('./HelpSettingsPage').then((m) => ({ default: m.HelpSettingsPage })),
      aclSnippet: `pm.${this.options.name || 'plugin-advance-settings'}`,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'advance-settings',
      key: 'ai-chat',
      title: this.t('AI Chat'),
      sort: 20,
      componentLoader: () => import('./AIChatSettingsPage').then((m) => ({ default: m.AIChatSettingsPage })),
      aclSnippet: `pm.${this.options.name || 'plugin-advance-settings'}`,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'advance-settings',
      key: 'settings-search',
      title: this.t('Settings Search'),
      sort: 30,
      componentLoader: () =>
        import('./SettingsSearchSettingsPage').then((m) => ({ default: m.SettingsSearchSettingsPage })),
      aclSnippet: `pm.${this.options.name || 'plugin-advance-settings'}`,
    });
  }
}

export default PluginAdvanceSettingsClient;
