import { Plugin } from '@nocobase/client';
import React from 'react';
import {
  GitRepositoryWorkContext,
  GitMergeRequestWorkContext,
  GitCommitWorkContext,
} from './ai-context';

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

    const aiManager = (this.app as any).aiManager;
    if (aiManager?.registerWorkContext) {
      aiManager.registerWorkContext('git-repository', GitRepositoryWorkContext);
      aiManager.registerWorkContext('git-merge-request', GitMergeRequestWorkContext);
      aiManager.registerWorkContext('git-commit', GitCommitWorkContext);
    }
  }
}

export default PluginGitManagerClient;
