import React from 'react';
import { Plugin, Application } from '@nocobase/client-v2';
import { AI_API_ACL_SNIPPET } from '../constants';

interface PermissionTabOptions {
  key: string;
  label: string;
  sort?: number;
  componentLoader: () => Promise<{ default: React.ComponentType<{ activeRole?: { name?: string } | null }> }>;
}

interface AclPluginV2Compat {
  settingsUI?: {
    addPermissionsTab?: (options: PermissionTabOptions) => void;
  };
}

export class PluginAiApiClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'ai-api',
      title: this.t('AI API Gateway'),
      icon: 'ApiOutlined',
      aclSnippet: AI_API_ACL_SNIPPET,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai-api',
      key: 'index',
      title: this.t('Configuration'),
      aclSnippet: AI_API_ACL_SNIPPET,
      sort: 1,
      componentLoader: () => import('./pages/GeneralPage'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai-api',
      key: 'model-pricing',
      title: this.t('Model pricing'),
      aclSnippet: AI_API_ACL_SNIPPET,
      sort: 2,
      componentLoader: () => import('./pages/ModelPricingPage'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai-api',
      key: 'model-metadata',
      title: this.t('Model metadata'),
      aclSnippet: AI_API_ACL_SNIPPET,
      sort: 3,
      componentLoader: () => import('./pages/ModelMetadataPage'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai-api',
      key: 'user-quotas',
      title: this.t('User quotas'),
      aclSnippet: AI_API_ACL_SNIPPET,
      sort: 4,
      componentLoader: () => import('./pages/UserQuotasPage'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai-api',
      key: 'usage',
      title: this.t('Usage'),
      aclSnippet: AI_API_ACL_SNIPPET,
      sort: 5,
      componentLoader: () => import('./pages/UsagePage'),
    });

    const aclPlugin = this.app.pm.get('@nocobase/plugin-acl') as AclPluginV2Compat | undefined;
    aclPlugin?.settingsUI?.addPermissionsTab?.({
      key: 'aiApi',
      label: this.t('AI API'),
      sort: 25,
      componentLoader: () => import('./pages/RolePermissionsTab'),
    });
  }
}

export default PluginAiApiClient;
