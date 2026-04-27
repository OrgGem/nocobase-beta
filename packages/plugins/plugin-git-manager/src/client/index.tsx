import { Plugin } from '@nocobase/client';
import React from 'react';

const GitManagerSettings = React.lazy(() =>
  import('./components/GitManagerSettings').then((m) => ({ default: m.GitManagerSettings })),
);

export class PluginGitManagerClient extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add('git-manager', {
      title: this.t('Git Manager'),
      icon: 'BranchesOutlined',
      Component: GitManagerSettings,
      aclSnippet: 'pm.plugin-git-manager',
    });
  }
}

export default PluginGitManagerClient;
