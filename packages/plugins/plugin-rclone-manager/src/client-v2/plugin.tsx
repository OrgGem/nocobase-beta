// SPDX-License-Identifier: Apache-2.0

import { Application, ExtendCollectionsProvider, Plugin } from '@nocobase/client-v2';
import { RCLONE_PERMISSION_ITEMS, RCLONE_SNIPPETS, SETTINGS_KEY } from '../shared/constants';
import { rcloneTransferTaskCollection } from '../shared/transfer-task-collection';
import { registerRcloneWorkflowInstructionsV2, type WorkflowInstructionRegistryLike } from './workflow/instructions';

export class PluginRcloneManagerClientV2 extends Plugin<Record<string, never>, Application> {
  async load() {
    this.app.addProvider(ExtendCollectionsProvider, {
      collections: [rcloneTransferTaskCollection],
    });

    const workflow = this.app.pm.get<WorkflowInstructionRegistryLike>('workflow');
    if (workflow) {
      registerRcloneWorkflowInstructionsV2(workflow);
    }

    this.pluginSettingsManager.addMenuItem({
      key: SETTINGS_KEY,
      title: this.t('Rclone Manager'),
      icon: 'CloudSyncOutlined',
      aclSnippet: RCLONE_SNIPPETS.access,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: SETTINGS_KEY,
      key: 'dashboard',
      title: this.t('Dashboard'),
      aclSnippet: RCLONE_SNIPPETS.read,
      sort: 1,
      componentLoader: () => import('./components/RcloneDashboard'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: SETTINGS_KEY,
      key: 'remotes',
      title: this.t('Remotes'),
      aclSnippet: RCLONE_SNIPPETS.read,
      sort: 10,
      componentLoader: () => import('./components/RcloneRemotes'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: SETTINGS_KEY,
      key: 'explorer',
      title: this.t('Explorer'),
      aclSnippet: RCLONE_SNIPPETS.read,
      sort: 20,
      componentLoader: () => import('./components/RcloneExplorer'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: SETTINGS_KEY,
      key: 'transfers',
      title: this.t('Transfers'),
      aclSnippet: RCLONE_SNIPPETS.read,
      sort: 30,
      componentLoader: () => import('./components/RcloneTransfers'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: SETTINGS_KEY,
      key: 'mounts',
      title: this.t('Mounts'),
      aclSnippet: RCLONE_SNIPPETS.mounts,
      sort: 40,
      componentLoader: () => import('./components/RcloneMounts'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: SETTINGS_KEY,
      key: 'serves',
      title: this.t('Serves'),
      aclSnippet: RCLONE_SNIPPETS.serves,
      sort: 50,
      componentLoader: () => import('./components/RcloneServes'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: SETTINGS_KEY,
      key: 'settings',
      title: this.t('Connections & Config'),
      aclSnippet: RCLONE_SNIPPETS.connections,
      sort: 60,
      componentLoader: () => import('./components/RcloneSettings'),
    });

    for (const [index, item] of RCLONE_PERMISSION_ITEMS.entries()) {
      this.pluginSettingsManager.addPageTabItem({
        menuKey: SETTINGS_KEY,
        key: item.key,
        title: this.t(item.title),
        aclSnippet: item.aclSnippet,
        hidden: true,
        sort: 100 + index,
      });
    }
  }
}

export default PluginRcloneManagerClientV2;
