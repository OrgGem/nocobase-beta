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
  name: 'sftpStorageConfigs',
  title: 'SFTP Storage Configurations',
  fields: [
    {
      type: 'bigInt',
      name: 'id',
      primaryKey: true,
      autoIncrement: true,
    },
    {
      type: 'string',
      name: 'title',
      length: 255,
      comment: 'Display name for this SFTP configuration',
    },
    {
      type: 'string',
      name: 'name',
      length: 255,
      unique: true,
      comment: 'Unique identifier for this SFTP configuration',
    },
    {
      type: 'string',
      name: 'host',
      length: 255,
      comment: 'SFTP server hostname or IP',
    },
    {
      type: 'integer',
      name: 'port',
      defaultValue: 22,
      comment: 'SFTP server port',
    },
    {
      type: 'string',
      name: 'username',
      length: 255,
      comment: 'SFTP login username',
    },
    {
      type: 'string',
      name: 'authMethod',
      length: 50,
      defaultValue: 'password',
      comment: 'Authentication method: password or privateKey',
    },
    {
      type: 'password',
      name: 'password',
      comment: 'Encrypted password for password auth',
    },
    {
      type: 'text',
      name: 'privateKey',
      comment: 'PEM format private key for key auth',
    },
    {
      type: 'password',
      name: 'passphrase',
      comment: 'Passphrase for the private key',
    },
    {
      type: 'string',
      name: 'basePath',
      length: 1024,
      defaultValue: '/',
      comment: 'Base directory on the SFTP server',
    },
    {
      type: 'boolean',
      name: 'enabled',
      defaultValue: true,
      comment: 'Whether this configuration is active',
    },
  ],
  timestamps: true,
  createdBy: true,
  updatedBy: true,
});
