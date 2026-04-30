/**
 * plugin-user-memory — Client-side plugin.
 *
 * Registers the plugin settings page where admins can configure
 * memory synthesis settings and users can view their memory profiles.
 */

import { Plugin } from '@nocobase/client';
import React from 'react';

const MemorySettingsPage = React.lazy(() => import('./components/MemorySettingsPage'));

export class PluginUserMemoryClient extends Plugin {
  async afterAdd() {}

  async beforeLoad() {}

  async load() {
    // Register plugin settings page
    this.app.pluginSettingsManager.add(this.name, {
      title: '{{t("User Memory")}}',
      icon: 'BulbOutlined',
      Component: MemorySettingsPage,
    });
  }
}

export default PluginUserMemoryClient;
