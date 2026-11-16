// SPDX-License-Identifier: Apache-2.0

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
