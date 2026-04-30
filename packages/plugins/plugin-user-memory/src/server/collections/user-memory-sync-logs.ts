import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'userMemorySyncLogs',
  migrationRules: ['schema-only'],
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
      name: 'syncType',
      type: 'string',
      defaultValue: 'scheduled',
      comment: 'scheduled | manual',
    },
    {
      name: 'conversationsProcessed',
      type: 'integer',
      defaultValue: 0,
    },
    {
      name: 'messagesProcessed',
      type: 'integer',
      defaultValue: 0,
    },
    {
      name: 'previousVersion',
      type: 'integer',
    },
    {
      name: 'newVersion',
      type: 'integer',
    },
    {
      name: 'changeSummary',
      type: 'text',
      comment: 'Brief summary of what changed in this sync',
    },
    {
      name: 'error',
      type: 'text',
      comment: 'Error message if sync failed',
    },
    {
      name: 'status',
      type: 'string',
      defaultValue: 'success',
      comment: 'success | error | skipped',
    },
    {
      type: 'date',
      name: 'createdAt',
      field: 'createdAt',
    },
  ],
});
