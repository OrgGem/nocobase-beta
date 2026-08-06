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
import { AI_API_ACL_SNIPPET } from '../constants';
import React from 'react';

const AiApiConfigPage = React.lazy(() => import('../client-v2/pages/GeneralPage'));
const AiApiModelPricingPage = React.lazy(() => import('../client-v2/pages/ModelPricingPage'));
const AiApiModelMetadataPage = React.lazy(() => import('../client-v2/pages/ModelMetadataPage'));
const AiApiUserQuotasPage = React.lazy(() => import('../client-v2/pages/UserQuotasPage'));
const AiApiUsagePage = React.lazy(() => import('../client-v2/pages/UsagePage'));
const { AiApiRolePermissions } = lazy(() => import('./components/AiApiRolePermissions'), 'AiApiRolePermissions');

export class PluginAiApiClient extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add('ai-api', {
      icon: 'ApiOutlined',
      title: this.t('AI API Gateway'),
      aclSnippet: AI_API_ACL_SNIPPET,
    });

    this.app.pluginSettingsManager.add('ai-api.config', {
      title: this.t('Configuration'),
      Component: AiApiConfigPage,
      aclSnippet: AI_API_ACL_SNIPPET,
      sort: 1,
    });

    this.app.pluginSettingsManager.add('ai-api.model-pricing', {
      title: this.t('Model pricing'),
      Component: AiApiModelPricingPage,
      aclSnippet: AI_API_ACL_SNIPPET,
      sort: 2,
    });

    this.app.pluginSettingsManager.add('ai-api.model-metadata', {
      title: this.t('Model metadata'),
      Component: AiApiModelMetadataPage,
      aclSnippet: AI_API_ACL_SNIPPET,
      sort: 3,
    });

    this.app.pluginSettingsManager.add('ai-api.user-quotas', {
      title: this.t('User quotas'),
      Component: AiApiUserQuotasPage,
      aclSnippet: AI_API_ACL_SNIPPET,
      sort: 4,
    });

    this.app.pluginSettingsManager.add('ai-api.usage', {
      title: this.t('Usage'),
      Component: AiApiUsagePage,
      aclSnippet: AI_API_ACL_SNIPPET,
      sort: 5,
    });

    // Add "AI API" tab in Settings → Users & Permissions → [Role]
    const aclPlugin = this.app.pm.get(PluginACLClient);
    if (aclPlugin?.settingsUI) {
      aclPlugin.settingsUI.addPermissionsTab(({ t, TabLayout, activeRole }) => ({
        key: 'aiApi',
        label: t('AI API', { ns: ['plugin-ai-api', 'client'] }),
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
