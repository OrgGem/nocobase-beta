/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export default {
  name: 'nextAppConfig',
  dumpRules: 'required',
  migrationRules: ['overwrite', 'schema-only'],
  inherit: false,
  hidden: false,
  description: null,
  fields: [
    {
      name: 'id',
      type: 'bigInt',
      autoIncrement: true,
      primaryKey: true,
      allowNull: false,
      uiSchema: {
        type: 'number',
        title: '{{t("ID")}}',
        'x-component': 'InputNumber',
        'x-read-pretty': true,
      },
    },
    {
      name: 'path',
      type: 'string',
      interface: 'input',
      description: null,
      collectionName: 'nextAppConfig',
      uiSchema: {
        type: 'string',
        'x-component': 'Input',
        title: '{{t("Path")}}',
      },
    },
    {
      name: 'title',
      type: 'string',
      interface: 'input',
      description: null,
      collectionName: 'nextAppConfig',
      uiSchema: {
        type: 'string',
        'x-component': 'Input',
        title: '{{t("Title")}}',
      },
    },
    {
      name: 'enabled',
      type: 'boolean',
      interface: 'checkbox',
      description: null,
      collectionName: 'nextAppConfig',
      defaultValue: true,
      uiSchema: {
        type: 'boolean',
        'x-component': 'Checkbox',
        title: '{{t("Enabled")}}',
      },
    },
    {
      name: 'createdAt',
      type: 'date',
      interface: 'createdAt',
      description: null,
      collectionName: 'nextAppConfig',
      field: 'createdAt',
      uiSchema: {
        type: 'datetime',
        title: '{{t("Created at")}}',
        'x-component': 'DatePicker',
        'x-component-props': {},
        'x-read-pretty': true,
      },
    },
    {
      name: 'updatedAt',
      type: 'date',
      interface: 'updatedAt',
      description: null,
      collectionName: 'nextAppConfig',
      field: 'updatedAt',
      uiSchema: {
        type: 'string',
        title: '{{t("Last updated at")}}',
        'x-component': 'DatePicker',
        'x-component-props': {},
        'x-read-pretty': true,
      },
    },
    {
      name: 'routes',
      type: 'hasMany',
      target: 'nextAppRoutes',
      foreignKey: 'configId',
    },
  ],
  category: [],
  logging: true,
  autoGenId: true,
  createdAt: true,
  updatedAt: true,
  filterTargetKey: 'id',
} as any;
