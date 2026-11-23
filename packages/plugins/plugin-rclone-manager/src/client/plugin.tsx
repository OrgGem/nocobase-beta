// SPDX-License-Identifier: Apache-2.0

import { Plugin } from '@nocobase/client';
import { RCLONE_PERMISSION_ITEMS, RCLONE_SNIPPETS, SETTINGS_KEY } from '../shared/constants';
import { rcloneTransferTaskCollection } from '../shared/transfer-task-collection';
import { registerRcloneWorkflowInstructionsLegacy, type LegacyWorkflowRegistryLike } from './workflow/instructions';

export class PluginRcloneManagerClient extends Plugin {
  async load() {
    const mainDataSource = this.app.dataSourceManager.getDataSource('main');
    if (mainDataSource) {
      const registerTaskCollection = () => {
        if (!mainDataSource.collectionManager.getCollection(rcloneTransferTaskCollection.name)) {
          mainDataSource.collectionManager.addCollections([rcloneTransferTaskCollection]);
        }
      };
      registerTaskCollection();
      mainDataSource.addReloadCallback(registerTaskCollection);
    }

    const workflow = this.app.pm.get<LegacyWorkflowRegistryLike>('workflow');
    if (workflow) {
      registerRcloneWorkflowInstructionsLegacy(workflow);
    }

    this.app.pluginSettingsManager.add(SETTINGS_KEY, {
      title: this.t('Rclone Manager'),
      icon: 'CloudSyncOutlined',
      aclSnippet: RCLONE_SNIPPETS.access,
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.dashboard`, {
      title: this.t('Dashboard'),
      aclSnippet: RCLONE_SNIPPETS.read,
      sort: 1,
      componentLoader: () => import('../client-v2/components/RcloneDashboard'),
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.remotes`, {
      title: this.t('Remotes'),
      aclSnippet: RCLONE_SNIPPETS.read,
      sort: 10,
      componentLoader: () => import('../client-v2/components/RcloneRemotes'),
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.explorer`, {
      title: this.t('Explorer'),
      aclSnippet: RCLONE_SNIPPETS.read,
      sort: 20,
      componentLoader: () => import('../client-v2/components/RcloneExplorer'),
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.transfers`, {
      title: this.t('Transfers'),
      aclSnippet: RCLONE_SNIPPETS.read,
      sort: 30,
      componentLoader: () => import('../client-v2/components/RcloneTransfers'),
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.mounts`, {
      title: this.t('Mounts'),
      aclSnippet: RCLONE_SNIPPETS.mounts,
      sort: 40,
      componentLoader: () => import('../client-v2/components/RcloneMounts'),
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.serves`, {
      title: this.t('Serves'),
      aclSnippet: RCLONE_SNIPPETS.serves,
      sort: 50,
      componentLoader: () => import('../client-v2/components/RcloneServes'),
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.settings`, {
      title: this.t('Connections & Config'),
      aclSnippet: RCLONE_SNIPPETS.connections,
      sort: 60,
      componentLoader: () => import('../client-v2/components/RcloneSettings'),
    });

    for (const [index, item] of RCLONE_PERMISSION_ITEMS.entries()) {
      this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.${item.key}`, {
        title: this.t(item.title),
        aclSnippet: item.aclSnippet,
        hidden: true,
        isTopLevel: false,
        sort: 100 + index,
      });
    }
  }
}

export default PluginRcloneManagerClient;
