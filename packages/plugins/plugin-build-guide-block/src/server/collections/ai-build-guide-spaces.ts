import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'aiBuildGuideSpaces',
  shared: true,
  dumpRules: 'required',
  migrationRules: ['overwrite', 'schema-only'],
  timestamps: true,
  fields: [
    {
      type: 'uid',
      name: 'id',
      primaryKey: true,
    },
    {
      type: 'string',
      name: 'title',
    },
    {
      type: 'string',
      name: 'llmService',
    },
    {
      type: 'string',
      name: 'model',
    },
    {
      type: 'text',
      name: 'systemPrompt',
    },
    {
      type: 'string',
      name: 'outputFormat',
      defaultValue: 'html',
    },
    {
      type: 'integer',
      name: 'targetChapterCount',
      defaultValue: 5,
    },
    {
      type: 'text',
      name: 'chapterGuidance',
    },
    {
      type: 'text',
      name: 'generatedHtml',
    },
    {
      type: 'text',
      name: 'generatedMarkdown',
    },
    {
      type: 'json',
      name: 'planJson',
    },
    {
      type: 'string',
      name: 'buildPhase',
      defaultValue: 'idle',
    },
    {
      type: 'string',
      name: 'buildRunId',
    },
    {
      type: 'date',
      name: 'buildQueuedAt',
    },
    {
      type: 'date',
      name: 'buildStartedAt',
    },
    {
      type: 'date',
      name: 'buildHeartbeatAt',
    },
    {
      type: 'string',
      name: 'buildWorkerId',
    },
    {
      type: 'integer',
      name: 'pageCount',
      defaultValue: 0,
    },
    {
      type: 'string',
      name: 'sourceHash',
    },
    {
      type: 'string',
      name: 'status',
      defaultValue: 'draft',
    },
    {
      type: 'text',
      name: 'buildLog',
    },
    {
      type: 'belongsToMany',
      name: 'documents',
      target: 'attachments',
    },
    {
      type: 'hasMany',
      name: 'pages',
      target: 'aiBuildGuidePages',
      foreignKey: 'spaceId',
    },
  ],
});
