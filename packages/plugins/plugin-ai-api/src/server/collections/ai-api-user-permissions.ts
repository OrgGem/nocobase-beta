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
  name: 'aiApiUserPermissions',
  autoGenId: true,
  fields: [
    { name: 'userId', type: 'bigInt', allowNull: false, index: true },
    {
      name: 'user',
      type: 'belongsTo',
      target: 'users',
      targetKey: 'id',
      foreignKey: 'userId',
      constraints: false,
    },
    { name: 'enabled', type: 'boolean', defaultValue: true, index: true },
    {
      name: 'allowedLlmServices',
      type: 'json',
      defaultValue: [],
      comment: 'LLM service names/titles this user may use. Empty means the user is denied every service.',
    },
    { name: 'allowAllModels', type: 'boolean', defaultValue: true },
    {
      name: 'allowedModels',
      type: 'json',
      defaultValue: [],
      comment: 'Array of "serviceName/modelId" this user may use (when allowAllModels=false)',
    },
  ],
  indexes: [
    {
      fields: ['userId'],
      unique: true,
    },
  ],
});
