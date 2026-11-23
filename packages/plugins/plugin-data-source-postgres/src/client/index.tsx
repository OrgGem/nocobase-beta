/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { DatabaseOutlined } from '@ant-design/icons';
import { Plugin } from '@nocobase/client';
import PluginDataSourceManagerClient from '@nocobase/plugin-data-source-manager/client';
import { ConfigurationForm } from './ConfigurationForm';
import { DATA_SOURCE_TYPE, NAMESPACE } from '../constants';
import {
  PostgresGeneralCollectionTemplate,
  PostgresCalendarCollectionTemplate,
  PostgresTreeCollectionTemplate,
  PostgresFileCollectionTemplate,
  PostgresSQLCollectionTemplate,
} from './collection-templates';
import { PostgresAddCollection } from './AddCollectionAction';
import enUS from '../locale/en-US.json';
import zhCN from '../locale/zh-CN.json';

export class PluginDataSourcePostgresClient extends Plugin {
  async afterAdd() {
    this.app.i18n.addResources('en-US', NAMESPACE, enUS);
    this.app.i18n.addResources('zh-CN', NAMESPACE, zhCN);
  }

  async load() {
    const dsManagerPlugin = this.app.pm.get(PluginDataSourceManagerClient);
    if (!dsManagerPlugin) {
      return;
    }

    const templates = [
      PostgresGeneralCollectionTemplate,
      PostgresCalendarCollectionTemplate,
      PostgresTreeCollectionTemplate,
      PostgresFileCollectionTemplate,
      PostgresSQLCollectionTemplate,
    ];

    dsManagerPlugin.registerType(DATA_SOURCE_TYPE, {
      name: DATA_SOURCE_TYPE,
      label: this.app.i18n.t('External PostgreSQL Database', { ns: NAMESPACE }),
      icon: DatabaseOutlined,
      DataSourceSettingsForm: ConfigurationForm,
      allowCollectionCreate: true,
      allowCollectionDeletion: true,
      disabledConfigureFields: false,
      disableAddFields: false,
      collectionListParams: () => ({
        pageSize: 50,
        sort: 'sort',
        filter: {
          'hidden.$isFalsy': true,
        },
        appends: ['fields'],
      }),
      AddCollection: PostgresAddCollection,
      collectionTemplates: templates,
    });
  }
}

export default PluginDataSourcePostgresClient;
