/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { ISchema, Plugin, lazy } from '@nocobase/client';
import PluginACLClient from '@nocobase/plugin-acl/client';
const { AdminSharedFormList } = lazy(() => import('./components/AdminSharedFormList'), 'AdminSharedFormList');
const { AdminSharedFormPage } = lazy(() => import('./components/AdminSharedFormPage'), 'AdminSharedFormPage');
const { SharedFormPage } = lazy(() => import('./components/SharedFormPage'), 'SharedFormPage');
const { SharedFormsPermissionTab } = lazy(
  () => import('./components/SharedFormsPermissionTab'),
  'SharedFormsPermissionTab',
);

import { formSchemaCallback } from './schemas/formSchemaCallback';
import { sharedFormBlockSettings, sharedMarkdownBlockSettings } from './settings';
import { NAMESPACE } from './locale';

export class PluginSharedFormsClient extends Plugin {
  protected formTypes = new Map();

  registerFormType(type: string, options: { label: string; uiSchema: (options: any) => ISchema }) {
    this.formTypes.set(type, options);
  }

  getFormSchemaByType(type = 'form') {
    if (this.formTypes.get(type)) {
      return this.formTypes.get(type).uiSchema;
    }
    return () => {
      return null;
    };
  }

  getFormTypeOptions() {
    const options = [];
    for (const [value, { label }] of this.formTypes) {
      options.push({ value, label });
    }
    return options;
  }

  async load() {
    this.app.schemaSettingsManager.add(sharedFormBlockSettings);
    this.app.schemaSettingsManager.add(sharedMarkdownBlockSettings);

    // Add "Shared Forms" tab in Settings → Users & Permissions → [Role]
    const aclPlugin = this.app.pm.get(PluginACLClient);
    if (aclPlugin?.settingsUI) {
      aclPlugin.settingsUI.addPermissionsTab(({ t, TabLayout, activeRole }) => ({
        key: 'sharedForms',
        label: t('Shared forms', { ns: NAMESPACE }),
        sort: 30,
        children: React.createElement(SharedFormsPermissionTab, { TabLayout, activeRole }),
      }));
    }

    this.registerFormType('form', {
      label: 'Form',
      uiSchema: formSchemaCallback,
    });

    // Route requires authentication (no skipAuthCheck)
    this.app.router.add('shared-forms', {
      path: '/shared-forms/:name',
      Component: SharedFormPage,
    });

    this.app.pluginSettingsManager.add('shared-forms', {
      title: `{{t("Shared forms", { ns: "${NAMESPACE}" })}}`,
      icon: 'LockOutlined',
      Component: AdminSharedFormList,
    });

    this.app.pluginSettingsManager.add(`shared-forms/:name`, {
      title: false,
      pluginKey: 'shared-forms',
      isTopLevel: false,
      Component: AdminSharedFormPage,
    });
  }
}

export default PluginSharedFormsClient;
