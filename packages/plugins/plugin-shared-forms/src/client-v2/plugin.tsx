/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin, Application } from '@nocobase/client-v2';
import type PluginACLClient from '@nocobase/plugin-acl/client-v2';
import { SharedFormModel, SharedFormSubmitActionModel } from './models';

export class PluginSharedFormsClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.flowEngine.registerModels({ SharedFormModel, SharedFormSubmitActionModel });
    this.app.router.add('shared-forms', {
      path: '/shared-forms/:name',
      authCheck: true,
      componentLoader: () => import('./SharedFormPage'),
    });
    this.pluginSettingsManager.addMenuItem({
      key: 'shared-forms',
      title: this.t('Shared forms'),
      icon: 'LockOutlined',
      aclSnippet: `pm.${this.options.name || 'shared-forms'}`,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'shared-forms',
      key: 'index',
      title: this.t('Shared forms'),
      aclSnippet: `pm.${this.options.name || 'shared-forms'}`,
      componentLoader: () => import('./AdminForms'),
    });
    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'shared-forms',
      key: ':name',
      title: false,
      hidden: true,
      aclSnippet: `pm.${this.options.name || 'shared-forms'}`,
      componentLoader: () => import('./FormDesigner'),
    });
    this.app.pm.get<PluginACLClient>('acl')?.settingsUI.addPermissionsTab({
      key: 'sharedForms',
      label: String(this.t('Shared forms')),
      sort: 30,
      componentLoader: () => import('./Permissions'),
    });
  }
}

export default PluginSharedFormsClient;
