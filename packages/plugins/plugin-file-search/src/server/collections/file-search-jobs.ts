import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'fileSearchJobs',
  title: 'File search jobs',
  filterTargetKey: 'id',
  fields: [
    {
      type: 'belongsTo',
      name: 'document',
      target: 'fileSearchDocuments',
      foreignKey: 'documentId',
      onDelete: 'CASCADE',
    },
    { type: 'bigInt', name: 'documentId', index: true },
    { type: 'string', name: 'action', defaultValue: 'index', index: true },
    { type: 'string', name: 'status', defaultValue: 'queued', index: true },
    { type: 'integer', name: 'priority', defaultValue: 0 },
    { type: 'integer', name: 'attempts', defaultValue: 0 },
    { type: 'date', name: 'queuedAt' },
    { type: 'date', name: 'startedAt' },
    { type: 'date', name: 'finishedAt' },
    { type: 'string', name: 'workerId' },
    { type: 'text', name: 'errorMessage' },
  ],
});
