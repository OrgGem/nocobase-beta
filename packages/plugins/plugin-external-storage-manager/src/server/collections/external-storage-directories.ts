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
  name: 'externalStorageDirectories',
  title: 'External Storage Directories',
  fields: [
    {
      type: 'bigInt',
      name: 'id',
      primaryKey: true,
      autoIncrement: true,
    },
    {
      type: 'string',
      name: 'name',
      length: 255,
      comment: 'Display name for this virtual directory',
    },
    {
      type: 'string',
      name: 'slug',
      length: 255,
      unique: true,
      comment: 'URL-safe unique identifier',
    },
    {
      type: 'string',
      name: 'storageType',
      length: 50,
      comment: 'Storage backend type: s3-private or sftp-private',
    },
    {
      type: 'string',
      name: 'storageConfigName',
      length: 255,
      comment: 'References the storage configuration name (s3 storage name or sftp config name)',
    },
    {
      type: 'string',
      name: 'rootPath',
      length: 1024,
      defaultValue: '/',
      comment: 'Root path in the external storage',
    },
    {
      type: 'text',
      name: 'description',
      comment: 'Optional description for this directory',
    },
    {
      type: 'boolean',
      name: 'enabled',
      defaultValue: true,
      comment: 'Whether this directory mapping is active',
    },
    {
      type: 'integer',
      name: 'sort',
      defaultValue: 0,
      comment: 'Display order',
    },
    {
      type: 'hasMany',
      name: 'permissions',
      target: 'externalStorageDirectoryPermissions',
      foreignKey: 'directoryId',
      onDelete: 'CASCADE',
    },
  ],
  timestamps: true,
  createdBy: true,
  updatedBy: true,
});
