import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'userMemoryProfiles',
  migrationRules: ['schema-only'],
  indexes: [
    {
      fields: ['userId'],
      unique: true,
    },
  ],
  fields: [
    {
      type: 'bigInt',
      name: 'id',
      primaryKey: true,
      autoIncrement: true,
    },
    {
      name: 'user',
      type: 'belongsTo',
      target: 'users',
      targetKey: 'id',
      foreignKey: 'userId',
    },
    {
      name: 'memoryContent',
      type: 'text',
      comment: 'Markdown-formatted user memory profile',
    },
    {
      name: 'memoryVersion',
      type: 'integer',
      defaultValue: 0,
      comment: 'Incremented on each successful sync',
    },
    {
      name: 'lastSyncedAt',
      type: 'date',
      comment: 'Timestamp of last successful sync',
    },
    {
      name: 'lastConversationSessionId',
      type: 'string',
      comment: 'Session ID of the last processed conversation',
    },
    {
      name: 'status',
      type: 'string',
      defaultValue: 'idle',
      comment: 'idle | processing | error',
    },
    {
      name: 'enabled',
      type: 'boolean',
      defaultValue: true,
      comment: 'Per-user toggle to enable/disable memory injection',
    },
    {
      name: 'metadata',
      type: 'jsonb',
      defaultValue: {},
      comment: 'Additional info: tokenCount, categories, etc.',
    },
    {
      type: 'date',
      name: 'createdAt',
      field: 'createdAt',
    },
    {
      type: 'date',
      name: 'updatedAt',
      field: 'updatedAt',
    },
  ],
});
