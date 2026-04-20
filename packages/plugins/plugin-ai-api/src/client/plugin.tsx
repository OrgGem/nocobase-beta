/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin, lazy } from '@nocobase/client';
import PluginACLClient from '@nocobase/plugin-acl/client';
import React from 'react';

const AiApiConfigPage = React.lazy(() => import('./AiApiConfigPage'));
const { AiApiRolePermissions } = lazy(() => import('./components/AiApiRolePermissions'), 'AiApiRolePermissions');

export class PluginAiApiClient extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add('ai-api', {
      icon: 'ApiOutlined',
      title: this.t('AI API Gateway'),
      aclSnippet: 'pm.ai-api.configuration',
    });

    this.app.pluginSettingsManager.add('ai-api.config', {
      title: this.t('Configuration'),
      Component: AiApiConfigPage,
    });

    // Add "AI API" tab in Settings → Users & Permissions → [Role]
    const aclPlugin = this.app.pm.get(PluginACLClient);
    if (aclPlugin?.settingsUI) {
      aclPlugin.settingsUI.addPermissionsTab(({ t, TabLayout, activeRole }) => ({
        key: 'aiApi',
        label: 'AI API',
        sort: 25,
        children: (
          <TabLayout>
            <AiApiRolePermissions role={activeRole} />
          </TabLayout>
        ),
      }));
    }
  }

}

export default PluginAiApiClient;
