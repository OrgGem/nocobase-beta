import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'packageRegistries',
  title: 'Package Registries',
  sortable: 'sort',
  fields: [
    {
      name: 'name',
      type: 'string',
      unique: true,
      required: true,
    },
    {
      name: 'title',
      type: 'string',
    },
    {
      name: 'format',
      type: 'string',
      required: true,
      defaultValue: 'npm',
      // enum: 'npm', 'pypi', 'nuget'
    },
    {
      name: 'type',
      type: 'string',
      required: true,
      defaultValue: 'hosted',
      // enum: 'hosted', 'proxy'
    },
    {
      name: 'upstreamUrl',
      type: 'string',
    },
    {
      name: 'authRequired',
      type: 'boolean',
      defaultValue: false,
    },
    {
      name: 'storage',
      type: 'belongsTo',
      target: 'storages', // Belongs to NocoBase storage configuration
      foreignKey: 'storageId',
    },
    {
      name: 'packages',
      type: 'hasMany',
      target: 'packages',
      foreignKey: 'registryId',
    },
  ],
});
