// SPDX-License-Identifier: Apache-2.0
import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'agentSessionAutoApprovals',
  title: 'Agent Session Auto Approvals',
  fields: [
    { name: 'id', type: 'bigInt', autoIncrement: true, primaryKey: true },
    { name: 'ownerId', type: 'bigInt', allowNull: false },
    { name: 'sessionId', type: 'string', length: 100, allowNull: false },
    { name: 'enabled', type: 'boolean', allowNull: false, defaultValue: false },
    { name: 'createdAt', type: 'date' },
    { name: 'updatedAt', type: 'date' },
  ],
  indexes: [{ unique: true, fields: ['ownerId', 'sessionId'] }],
});
