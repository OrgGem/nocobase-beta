import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'packages',
  title: 'Packages',
  indexes: [
    {
      fields: ['registryId', 'name'],
      unique: true,
    },
  ],
  fields: [
    {
      name: 'name',
      type: 'string',
      required: true,
    },
    {
      name: 'description',
      type: 'text',
    },
    {
      name: 'registry',
      type: 'belongsTo',
      target: 'packageRegistries',
      foreignKey: 'registryId',
    },
    {
      name: 'versions',
      type: 'hasMany',
      target: 'packageVersions',
      foreignKey: 'packageId',
    },
  ],
});
