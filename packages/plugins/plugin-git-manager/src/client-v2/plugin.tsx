import { Plugin, Application } from '@nocobase/client-v2';
import type PluginAIClientV2 from '@nocobase/plugin-ai/client-v2';
import type PluginAclClientV2 from '@nocobase/plugin-acl/client-v2';
import type { PermissionTabProps } from '@nocobase/plugin-acl/client-v2';
import React from 'react';
import { GitRepositoryWorkContext, GitMergeRequestWorkContext, GitCommitWorkContext } from './ai-context';

export class PluginGitManagerClient extends Plugin<Record<string, never>, Application> {
  async load() {
    const aiManager = this.app.pm.get<PluginAIClientV2>('ai')?.aiManager;
    aiManager?.registerWorkContext('git-repository', GitRepositoryWorkContext);
    aiManager?.registerWorkContext('git-merge-request', GitMergeRequestWorkContext);
    aiManager?.registerWorkContext('git-commit', GitCommitWorkContext);
    this.app.pm.get<PluginAclClientV2>('acl')?.settingsUI.addPermissionsTab({
      key: 'git-manager',
      label: this.t('Git Manager'),
      sort: 25,
      componentLoader: () =>
        import('../client/components/RepositoryPermissions').then(({ RepositoryPermissions }) => ({
          default: ({ activeRole }: PermissionTabProps) =>
            activeRole ? <RepositoryPermissions key={activeRole.name} activeRole={activeRole} /> : null,
        })),
    });
    this.pluginSettingsManager.addMenuItem({
      key: 'git-manager',
      title: this.t('Git Manager'),
      icon: 'BranchesOutlined',
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'git-manager',
      key: 'accounts',
      title: this.t('Git Accounts'),
      aclSnippet: 'pm.plugin-git-manager.repositories',
      componentLoader: () =>
        import('../client/components/GitAccounts').then((module) => ({ default: module.GitAccountsSettings })),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'git-manager',
      key: 'subtree-splits',
      title: this.t('Subtree Splits'),
      aclSnippet: 'pm.plugin-git-manager.write',
      componentLoader: () => import('./components/SubtreeSplits'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'git-manager',
      key: 'repositories',
      title: this.t('Repositories'),
      aclSnippet: 'pm.plugin-git-manager.repositories',
      componentLoader: () =>
        import('../client/components/RepositoryConfig').then((m) => ({ default: m.RepositoryConfigSettings })),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'git-manager',
      key: 'manage',
      title: this.t('Manage'),
      aclSnippet: 'pm.plugin-git-manager.manage',
      componentLoader: () =>
        import('../client/components/GitManagerSettings').then((m) => ({ default: m.GitManagerSettings })),
    });
  }
}

export default PluginGitManagerClient;
