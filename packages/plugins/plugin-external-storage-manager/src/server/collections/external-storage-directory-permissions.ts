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
  name: 'externalStorageDirectoryPermissions',
  title: 'External Storage Directory Permissions',
  fields: [
    {
      type: 'bigInt',
      name: 'id',
      primaryKey: true,
      autoIncrement: true,
    },
    {
      type: 'bigInt',
      name: 'directoryId',
      index: true,
      comment: 'FK to externalStorageDirectories',
    },
    {
      type: 'string',
      name: 'roleName',
      length: 255,
      index: true,
      comment: 'NocoBase role name',
    },
    {
      type: 'json',
      name: 'actions',
      defaultValue: [],
      comment: 'Array of allowed actions: list, view, upload, download, delete, mkdir',
    },
    {
      type: 'string',
      name: 'subPath',
      length: 1024,
      defaultValue: '',
      comment: 'Optional sub-path restriction within the directory (empty = full access from rootPath)',
    },
    {
      type: 'belongsTo',
      name: 'directory',
      target: 'externalStorageDirectories',
      foreignKey: 'directoryId',
    },
  ],
  timestamps: true,
  indexes: [
    {
      fields: ['directoryId', 'roleName'],
    },
  ],
});
