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
      type: 'text',
      name: 'generatedHtml',
    },
    {
      type: 'text',
      name: 'generatedMarkdown',
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
  ],
});
