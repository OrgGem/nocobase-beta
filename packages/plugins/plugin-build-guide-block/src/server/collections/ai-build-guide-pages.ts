import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'aiBuildGuidePages',
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
      type: 'belongsTo',
      name: 'space',
      target: 'aiBuildGuideSpaces',
      foreignKey: 'spaceId',
    },
    {
      type: 'integer',
      name: 'sort',
      defaultValue: 0,
    },
    {
      type: 'string',
      name: 'title',
    },
    {
      type: 'string',
      name: 'slug',
    },
    {
      type: 'text',
      name: 'goal',
    },
    {
      type: 'json',
      name: 'planItem',
    },
    {
      type: 'string',
      name: 'status',
      defaultValue: 'pending',
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
      type: 'text',
      name: 'buildLog',
    },
  ],
});
