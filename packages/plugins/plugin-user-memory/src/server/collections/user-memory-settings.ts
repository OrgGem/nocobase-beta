import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'userMemorySettings',
  migrationRules: ['schema-only'],
  fields: [
    {
      type: 'bigInt',
      name: 'id',
      primaryKey: true,
      autoIncrement: true,
    },
    {
      name: 'enabled',
      type: 'boolean',
      defaultValue: true,
      comment: 'Global toggle for the user memory feature',
    },
    {
      name: 'syncSchedule',
      type: 'string',
      defaultValue: '0 0 3 * * *',
      comment: 'Cron expression for scheduled sync (default: 3 AM daily)',
    },
    {
      name: 'llmService',
      type: 'string',
      comment: 'LLM service ID used for memory synthesis',
    },
    {
      name: 'llmModel',
      type: 'string',
      comment: 'LLM model used for memory synthesis',
    },
    {
      name: 'maxTokens',
      type: 'integer',
      defaultValue: 800,
      comment: 'Max token budget for the memory profile content',
    },
    {
      name: 'maxConversationsPerSync',
      type: 'integer',
      defaultValue: 50,
      comment: 'Max conversations to process per sync batch',
    },
    {
      name: 'syncLogRetentionDays',
      type: 'integer',
      defaultValue: 30,
      comment: 'Days to keep sync logs before cleanup',
    },
  ],
});
