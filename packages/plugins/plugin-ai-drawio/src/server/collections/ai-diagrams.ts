import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'aiDiagrams',
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
      type: 'text',
      name: 'description',
    },
    {
      type: 'text',
      name: 'xmlContent',
      length: 'long',
    },
    {
      type: 'text',
      name: 'thumbnailSvg',
      length: 'long',
    },
    {
      type: 'json',
      name: 'metadata',
    },
    {
      type: 'belongsTo',
      name: 'createdBy',
      target: 'users',
      foreignKey: 'createdById',
    },
    {
      type: 'belongsTo',
      name: 'updatedBy',
      target: 'users',
      foreignKey: 'updatedById',
    },
  ],
});
