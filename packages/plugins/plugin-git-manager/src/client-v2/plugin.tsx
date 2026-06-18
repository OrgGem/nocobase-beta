import { Plugin, Application } from '@nocobase/client-v2';
import React from 'react';

export class PluginGitManagerClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'git-manager',
      title: this.t('Git Manager'),
      icon: 'BranchesOutlined',
      
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'git-manager',
      key: 'repositories',
      title: this.t('Repositories'),
      aclSnippet: 'pm.plugin-git-manager.repositories',
      componentLoader: () => import('../client/components/RepositoryConfig').then(m => ({ default: m.RepositoryConfig })),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'git-manager',
      key: 'manage',
      title: this.t('Manage'),
      aclSnippet: 'pm.plugin-git-manager.manage',
      componentLoader: () => import('../client/components/GitManagerSettings').then(m => ({ default: m.GitManagerSettings })),
    });

  }
}

export default PluginGitManagerClient;
