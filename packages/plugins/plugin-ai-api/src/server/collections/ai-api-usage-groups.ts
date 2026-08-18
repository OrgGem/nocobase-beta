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
  name: 'aiApiUsageGroups',
  autoGenId: true,
  fields: [
    { name: 'name', type: 'string', allowNull: false },
    { name: 'isDefault', type: 'boolean', defaultValue: false, index: true },
    { name: 'quotaMode', type: 'string', allowNull: false, defaultValue: 'per_user' },
    { name: 'rateLimitPerMinute', type: 'integer', allowNull: false, defaultValue: 60 },
    { name: 'enabled', type: 'boolean', defaultValue: true, index: true },
    { name: 'periodType', type: 'string', allowNull: false, defaultValue: 'monthly' },
    { name: 'timezone', type: 'string', allowNull: false, defaultValue: 'UTC' },
    { name: 'requestLimit', type: 'bigInt', allowNull: true },
    { name: 'totalTokenLimit', type: 'bigInt', allowNull: true },
    { name: 'costLimit', type: 'decimal', precision: 20, scale: 8, allowNull: true },
    { name: 'currency', type: 'string', allowNull: false, defaultValue: 'USD' },
    { name: 'rejectUnpricedModel', type: 'boolean', defaultValue: true },
    { name: 'missingUsageBehavior', type: 'string', allowNull: false, defaultValue: 'use_reserved' },
    { name: 'contextOverflowBehavior', type: 'string', allowNull: false, defaultValue: 'reject' },
    // Model access: empty lists mean "no narrowing" — the group inherits the full
    // global configuration. Non-empty lists narrow what members may use.
    {
      name: 'allowedLlmServices',
      type: 'json',
      defaultValue: [],
      comment: 'Empty means all globally enabled services; otherwise narrows to these services.',
    },
    { name: 'allowAllModels', type: 'boolean', defaultValue: true },
    {
      name: 'allowedModels',
      type: 'json',
      defaultValue: [],
      comment: 'Array of "serviceName/modelId" members may use (when allowAllModels=false).',
    },
  ],
  indexes: [
    {
      fields: ['isDefault'],
      unique: true,
      where: { isDefault: true },
    },
  ],
});
