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

/**
 * Main settings page with tabs for Settings (directory config) and Browse Files.
 */
const ExternalStorageSettingsPage: React.FC = () => {
  return (
    <Tabs
      defaultActiveKey="browse"
      items={[
        {
          key: 'browse',
          label: 'Browse Files',
          children: (
            <React.Suspense fallback={<div style={{ padding: 40, textAlign: 'center' }}>Loading...</div>}>
              <FileBrowser />
            </React.Suspense>
          ),
        },
        {
          key: 'settings',
          label: 'Settings',
          children: (
            <React.Suspense fallback={<div style={{ padding: 40, textAlign: 'center' }}>Loading...</div>}>
              <DirectoryManager />
            </React.Suspense>
          ),
        },
      ]}
    />
  );
};

export class PluginExternalStorageManagerClient extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add(NAMESPACE, {
      title: 'External Storage Manager',
      icon: 'HddOutlined',
      Component: ExternalStorageSettingsPage,
      aclSnippet: `pm.plugin-external-storage-manager.directories`,
    });
  }
}

export default PluginExternalStorageManagerClient;
