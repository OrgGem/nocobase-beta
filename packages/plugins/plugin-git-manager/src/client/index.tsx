import { Plugin } from '@nocobase/client';
import React from 'react';
import { GitRepositoryWorkContext, GitMergeRequestWorkContext, GitCommitWorkContext } from './ai-context';

const GitManagerSettings = React.lazy(() =>
  import('./components/GitManagerSettings').then((m) => ({ default: m.GitManagerSettings })),
);

const RepositoryConfig = React.lazy(() =>
  import('./components/RepositoryConfig').then((m) => ({ default: m.RepositoryConfigSettings })),
);

const GitAccounts = React.lazy(() =>
  import('./components/GitAccounts').then((m) => ({ default: m.GitAccountsSettings })),
);

import PluginACLClient from '@nocobase/plugin-acl/client';
import { RepositoryPermissions } from './components/RepositoryPermissions';

export class PluginGitManagerClient extends Plugin {
  async load() {
    // Parent group with no direct component — acts as a category in settings
    this.app.pluginSettingsManager.add('git-manager', {
      title: (this as any).t('Git Manager'),
      icon: 'BranchesOutlined',
    });

    // Repositories config — separate group for ACL-granular access
    this.app.pluginSettingsManager.add('git-manager.repositories', {
      title: (this as any).t('Repositories'),
      Component: RepositoryConfig,
      aclSnippet: `pm.plugin-git-manager.repositories`,
    });

    // Git Accounts — separate group for managing shared credentials
    this.app.pluginSettingsManager.add('git-manager.accounts', {
      title: (this as any).t('Git Accounts'),
      Component: GitAccounts,
      aclSnippet: `pm.plugin-git-manager.repositories`,
    });

    // Full management — requires full plugin permission
    this.app.pluginSettingsManager.add('git-manager.manage', {
      title: (this as any).t('Manage'),
      Component: GitManagerSettings,
      aclSnippet: `pm.plugin-git-manager.manage`,
    });

    const aiManager = ((this as any).app as any).aiManager;
    if (aiManager?.registerWorkContext) {
      aiManager.registerWorkContext('git-repository', GitRepositoryWorkContext);
      aiManager.registerWorkContext('git-merge-request', GitMergeRequestWorkContext);
      aiManager.registerWorkContext('git-commit', GitCommitWorkContext);
    }

    const aclPlugin = this.app.pm.get(PluginACLClient);
    if (aclPlugin) {
      aclPlugin.settingsUI.addPermissionsTab(({ t, TabLayout, activeRole }) => ({
        key: 'git-manager',
        label: 'Git Manager',
        sort: 25,
        children: (
          <TabLayout>
            <RepositoryPermissions activeRole={activeRole} />
          </TabLayout>
        ),
      }));
    }
  }
}

export default PluginGitManagerClient;
