import { defineCollection } from '@nocobase/database';

export default defineCollection({
  dumpRules: 'skipped',
  migrationRules: ['schema-only', 'overwrite'],
  name: 'vietnamRegions',
  dataCategory: 'business',
  autoGenId: false,
  fields: [
    {
      name: 'code',
      type: 'string',
      primaryKey: true,
    },
    {
      name: 'name',
      type: 'string',
    },
    {
      name: 'parent',
      type: 'belongsTo',
      target: 'vietnamRegions',
      targetKey: 'code',
      foreignKey: 'parentCode',
    },
    {
      name: 'children',
      type: 'hasMany',
      target: 'vietnamRegions',
      sourceKey: 'code',
      foreignKey: 'parentCode',
    },
    {
      name: 'level',
      type: 'integer',
    },
  ],
});
