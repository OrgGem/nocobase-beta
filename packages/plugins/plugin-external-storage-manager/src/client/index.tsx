/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { Plugin } from '@nocobase/client';
import { Tabs } from 'antd';
import { NAMESPACE } from '../constants';

const FileBrowser = React.lazy(() => import('./components/FileBrowser'));
const DirectoryManager = React.lazy(() => import('./components/DirectoryManager'));

const FileBrowserPage = () => {
  return (
    <div style={{ padding: 24 }}>
      <React.Suspense fallback={<div style={{ padding: 40, textAlign: 'center' }}>Loading...</div>}>
        <FileBrowser />
      </React.Suspense>
    </div>
  );
};

import PluginACLClient from '@nocobase/plugin-acl/client';
import { ExternalStoragePermissions } from './components/ExternalStoragePermissions';

export class PluginExternalStorageManagerClient extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add(NAMESPACE, {
      title: 'External Storage',
      icon: 'HddOutlined',
    });

    this.app.pluginSettingsManager.add(`${NAMESPACE}.browse`, {
      title: 'Browse Files',
      Component: FileBrowserPage,
      aclSnippet: `pm.plugin-external-storage-manager.browse`,
    });

    this.app.pluginSettingsManager.add(`${NAMESPACE}.settings`, {
      title: 'Directory Settings',
      Component: () => (
        <React.Suspense fallback={<div style={{ padding: 40, textAlign: 'center' }}>Loading...</div>}>
          <DirectoryManager />
        </React.Suspense>
      ),
      aclSnippet: `pm.plugin-external-storage-manager.directories`,
    });

    // Exporting FileBrowser so it can be imported by other plugins
    this.app.addComponents({ FileBrowser });

    const aclPlugin = this.app.pm.get(PluginACLClient);
    if (aclPlugin) {
      aclPlugin.settingsUI.addPermissionsTab(({ t, TabLayout, activeRole }) => ({
        key: 'external-storage',
        label: 'External storage',
        sort: 25,
        children: (
          <TabLayout>
            <ExternalStoragePermissions activeRole={activeRole} />
          </TabLayout>
        ),
      }));
    }
  }
}

export default PluginExternalStorageManagerClient;

export { default as FileBrowser } from './components/FileBrowser';
export { DirectoryManager } from './components/DirectoryManager';
export { ExternalStoragePermissions } from './components/ExternalStoragePermissions';
