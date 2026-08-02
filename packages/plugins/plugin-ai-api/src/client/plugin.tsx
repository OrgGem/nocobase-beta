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

const AiApiConfigPage = React.lazy(() => import('../client-v2/pages/GeneralPage'));
const AiApiModelPricingPage = React.lazy(() => import('../client-v2/pages/ModelPricingPage'));
const AiApiUserQuotasPage = React.lazy(() => import('../client-v2/pages/UserQuotasPage'));
const AiApiUsagePage = React.lazy(() => import('../client-v2/pages/UsagePage'));
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
      aclSnippet: 'pm.ai-api.configuration',
      sort: 1,
    });

    this.app.pluginSettingsManager.add('ai-api.model-pricing', {
      title: this.t('Model pricing'),
      Component: AiApiModelPricingPage,
      aclSnippet: 'pm.ai-api.configuration',
      sort: 2,
    });

    this.app.pluginSettingsManager.add('ai-api.user-quotas', {
      title: this.t('User quotas'),
      Component: AiApiUserQuotasPage,
      aclSnippet: 'pm.ai-api.configuration',
      sort: 3,
    });

    this.app.pluginSettingsManager.add('ai-api.usage', {
      title: this.t('Usage'),
      Component: AiApiUsagePage,
      aclSnippet: 'pm.ai-api.configuration',
      sort: 4,
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
