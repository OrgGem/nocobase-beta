/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'customSubpaths',
  fields: [
    {
      type: 'bigInt',
      name: 'id',
      primaryKey: true,
      autoIncrement: true,
    },
    {
      type: 'string',
      name: 'path',
      length: 255,
      unique: true,
      interface: 'input',
      uiSchema: {
        title: '{{t("Path")}}',
        type: 'string',
        'x-component': 'Input',
        required: true,
      },
    },
    {
      type: 'string',
      name: 'title',
      length: 255,
      interface: 'input',
      uiSchema: {
        title: '{{t("Title")}}',
        type: 'string',
        'x-component': 'Input',
      },
    },
    {
      type: 'boolean',
      name: 'enabled',
      defaultValue: true,
      interface: 'checkbox',
      uiSchema: {
        title: '{{t("Enabled")}}',
        type: 'boolean',
        'x-component': 'Checkbox',
      },
    },
    {
      type: 'date',
      name: 'createdAt',
      field: 'createdAt',
      interface: 'createdAt',
      uiSchema: {
        title: '{{t("Created at")}}',
        type: 'datetime',
        'x-component': 'DatePicker',
        'x-component-props': { showTime: true },
        'x-read-pretty': true,
      },
    },
    {
      type: 'date',
      name: 'updatedAt',
      field: 'updatedAt',
      interface: 'updatedAt',
      uiSchema: {
        title: '{{t("Updated at")}}',
        type: 'datetime',
        'x-component': 'DatePicker',
        'x-component-props': { showTime: true },
        'x-read-pretty': true,
      },
    },
  ],
});
