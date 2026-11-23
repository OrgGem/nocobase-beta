/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { Application, Plugin } from '@nocobase/client-v2';
import PluginDataSourceManagerClientV2 from '@nocobase/plugin-data-source-manager/client-v2';
import { DATA_SOURCE_TYPE, DEFAULT_PORT, DEFAULT_SCHEMA } from '../constants';
import { PostgresAddCollection } from './PostgresAddCollection';
import { PostgresDeleteCollection } from './PostgresDeleteCollection';

const UNSUPPORTED_CREATE_FIELD_INTERFACES = [
  'formula',
  'sequence',
  'tableoid',
  'snapshot',
  'subTable',
  'linkTo',
  'createdBy',
  'updatedBy',
  'attachment',
  'o2o',
];

export class PluginDataSourcePostgresClientV2 extends Plugin<Record<string, never>, Application> {
  async load() {
    const manager = this.app.pm.get(PluginDataSourceManagerClientV2);
    manager?.registerType(DATA_SOURCE_TYPE, {
      label: String(this.t('External PostgreSQL Database')),
      defaultValues: {
        options: {
          host: 'localhost',
          port: DEFAULT_PORT,
          schema: DEFAULT_SCHEMA,
          ssl: false,
          addAllCollections: true,
        },
      },
      SettingsForm: React.lazy(() => import('./PostgresConfigForm')),
      allowCollectionCreate: true,
      allowCollectionDeletion: true,
      disableAddFields: false,
      createFieldInterfaces: ({ collection }) => {
        if (collection?.view || collection?.template === 'view' || collection?.sql || collection?.template === 'sql') {
          return { include: ['__none__'] };
        }
        return { exclude: UNSUPPORTED_CREATE_FIELD_INTERFACES };
      },
      AddCollection: PostgresAddCollection,
      DeleteCollection: PostgresDeleteCollection,
      normalizeValues: (values) => {
        const { __postgresPreserveLegacySelection, ...normalized } = values;
        const addAllCollections = values.options?.addAllCollections ?? values.options?.autoDiscover !== false;
        const options = { ...values.options, addAllCollections, autoDiscover: addAllCollections };
        if (__postgresPreserveLegacySelection && !addAllCollections) {
          delete normalized.collections;
        } else if (!addAllCollections) {
          options.selectedCollections = values.collections;
        }
        return { ...normalized, options };
      },
    });
  }
}

export default PluginDataSourcePostgresClientV2;
