/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { CollectionOptions } from '@nocobase/database';

export default {
  name: 'doc_understanding_api_keys',
  title: 'Document Understanding API Keys',
  fields: [
    { type: 'string', name: 'name', length: 200 },
    { type: 'string', name: 'keyPrefix', length: 32 },
    { type: 'string', name: 'keyHash', unique: true, length: 128 },
    { type: 'string', name: 'tenantId', length: 100, defaultValue: 'default' },
    { type: 'json', name: 'allowedBusinesses' },
    { type: 'json', name: 'allowedActions' },
    { type: 'json', name: 'requestDefaults' },
    { type: 'json', name: 'lockedFields' },
    { type: 'string', name: 'status', length: 20, defaultValue: 'active' },
    { type: 'date', name: 'expiresAt' },
    { type: 'date', name: 'lastUsedAt' },
    {
      type: 'belongsTo',
      name: 'createdBy',
      target: 'users',
      foreignKey: 'createdById',
    },
  ],
  indexes: [{ fields: ['tenantId'] }, { fields: ['status'] }],
} as CollectionOptions;
