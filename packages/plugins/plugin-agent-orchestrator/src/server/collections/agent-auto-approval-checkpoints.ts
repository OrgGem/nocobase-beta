// SPDX-License-Identifier: Apache-2.0
import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'agentAutoApprovalCheckpoints',
  autoGenId: false,
  title: 'Agent Auto Approval Checkpoints',
  fields: [
    { name: 'checkpointKey', type: 'string', length: 64, allowNull: false, primaryKey: true },
    { name: 'ownerId', type: 'bigInt', allowNull: false },
    { name: 'sessionId', type: 'string', length: 100, allowNull: false },
    { name: 'messageId', type: 'string', length: 100, allowNull: false },
    { name: 'interruptId', type: 'text', allowNull: false },
    { name: 'status', type: 'string', length: 16, allowNull: false, defaultValue: 'pending' },
    { name: 'createdAt', type: 'date' },
    { name: 'updatedAt', type: 'date' },
  ],
});
