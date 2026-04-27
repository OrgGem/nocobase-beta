import React from 'react';
import { Plugin } from '@nocobase/client';

/**
 * PluginCommCoreClient — Client-side foundation for the Communication Suite.
 *
 * This plugin provides:
 * 1. Plugin settings page for comm configuration
 * 2. Shared React context and hooks for comm data
 * 3. WebSocket event type constants
 */

const OverviewPlaceholder: React.FC = () => {
  return React.createElement('div', {
    style: { padding: 24, textAlign: 'center', color: '#999' },
  }, 'Communication Suite — Enable plugin-team-chat for full chat experience.');
};

export class PluginCommCoreClient extends Plugin {
  async load() {
    // Register settings page group
    this.app.pluginSettingsManager.add('comm-suite', {
      title: this.t('Communication Suite'),
      icon: 'CommentOutlined',
    });

    this.app.pluginSettingsManager.add('comm-suite.overview', {
      title: this.t('Overview'),
      Component: OverviewPlaceholder,
      aclSnippet: 'pm.plugin-comm-core',
    });
  }
}

export default PluginCommCoreClient;
