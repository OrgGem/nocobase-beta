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
  name: 'aiApiGroupQuotaBuckets',
  autoGenId: true,
  fields: [
    { name: 'groupId', type: 'bigInt', allowNull: false, index: true },
    {
      name: 'group',
      type: 'belongsTo',
      target: 'aiApiUsageGroups',
      targetKey: 'id',
      foreignKey: 'groupId',
      constraints: false,
    },
    // userId = 0 means the shared bucket in share mode; real user ids are always > 0.
    { name: 'userId', type: 'bigInt', allowNull: false, defaultValue: 0, index: true },
    { name: 'periodStart', type: 'datetimeTz', allowNull: false, index: true },
    { name: 'periodEnd', type: 'datetimeTz', allowNull: false },
    { name: 'requestCount', type: 'bigInt', allowNull: false, defaultValue: 0 },
    { name: 'totalTokens', type: 'bigInt', allowNull: false, defaultValue: 0 },
    { name: 'cost', type: 'decimal', precision: 20, scale: 8, allowNull: false, defaultValue: 0 },
    { name: 'reservedRequests', type: 'bigInt', allowNull: false, defaultValue: 0 },
    { name: 'reservedTokens', type: 'bigInt', allowNull: false, defaultValue: 0 },
    { name: 'reservedCost', type: 'decimal', precision: 20, scale: 8, allowNull: false, defaultValue: 0 },
  ],
  indexes: [
    {
      fields: ['groupId', 'userId', 'periodStart'],
      unique: true,
    },
  ],
});
