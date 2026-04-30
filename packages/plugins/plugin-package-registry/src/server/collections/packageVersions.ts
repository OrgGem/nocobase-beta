import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'packageVersions',
  title: 'Package Versions',
  fields: [
    {
      name: 'version',
      type: 'string',
      required: true,
    },
    {
      name: 'package',
      type: 'belongsTo',
      target: 'packages',
      foreignKey: 'packageId',
    },
    {
      name: 'metadata',
      type: 'jsonb',
      defaultValue: {},
    },
    {
      name: 'assets',
      type: 'hasMany',
      target: 'packageAssets',
      foreignKey: 'versionId',
    },
  ],
});
