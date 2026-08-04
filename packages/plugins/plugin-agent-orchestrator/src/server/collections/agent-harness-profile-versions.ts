import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'agentHarnessProfileVersions',
  title: 'Agent Harness Profile Versions',
  fields: [
    { name: 'id', type: 'bigInt', autoIncrement: true, primaryKey: true },
    { name: 'profileId', type: 'bigInt', allowNull: false },
    {
      name: 'profile',
      type: 'belongsTo',
      target: 'agentHarnessProfiles',
      foreignKey: 'profileId',
      allowNull: false,
    },
    { name: 'version', type: 'integer', allowNull: false },
    { name: 'schemaVersion', type: 'integer', allowNull: false, defaultValue: 1 },
    { name: 'status', type: 'string', length: 20, allowNull: false, defaultValue: 'draft' },
    { name: 'settings', type: 'json', allowNull: false, defaultValue: {} },
    { name: 'publishedBy', type: 'belongsTo', target: 'users', foreignKey: 'publishedById' },
    { name: 'publishedAt', type: 'date' },
    { name: 'createdAt', type: 'date' },
    { name: 'updatedAt', type: 'date' },
  ],
  indexes: [{ unique: true, fields: ['profileId', 'version'] }, { fields: ['profileId', 'status'] }],
});
