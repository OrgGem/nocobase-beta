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
  name: 'aiApiGroupMembers',
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
    { name: 'userId', type: 'bigInt', allowNull: false, index: true },
    {
      name: 'user',
      type: 'belongsTo',
      target: 'users',
      targetKey: 'id',
      foreignKey: 'userId',
      constraints: false,
    },
  ],
  indexes: [
    {
      fields: ['userId'],
      unique: true,
    },
  ],
});
