import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'aiBrowserConfig',
  shared: true,
  dumpRules: 'required',
  migrationRules: ['overwrite', 'schema-only'],
  timestamps: true,
  fields: [
    {
      type: 'string',
      name: 'key',
      primaryKey: true,
    },
    {
      type: 'text',
      name: 'value',
    },
  ],
});
