import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'skillRegistryPackages',
  title: 'Skill Registry Packages',
  autoGenId: true,
  createdAt: true,
  updatedAt: true,
  indexes: [
    { name: 'skill_registry_packages_identity', fields: ['namespace', 'slug'], unique: true },
    { name: 'skill_registry_packages_public_list', fields: ['visibility', 'status', 'publishedAt', 'id'] },
    { name: 'skill_registry_packages_status_updated', fields: ['status', 'updatedAt'] },
  ],
  fields: [
    { type: 'string', name: 'namespace', length: 80, allowNull: false },
    { type: 'string', name: 'slug', length: 120, allowNull: false },
    { type: 'string', name: 'displayName', length: 200, allowNull: false },
    { type: 'text', name: 'description', defaultValue: '' },
    { type: 'string', name: 'license', length: 80, allowNull: true },
    { type: 'json', name: 'tags', defaultValue: [] },
    { type: 'string', name: 'iconUrl', length: 1000, allowNull: true },
    { type: 'string', name: 'visibility', length: 16, defaultValue: 'public' },
    { type: 'string', name: 'status', length: 24, defaultValue: 'draft' },
    { type: 'string', name: 'defaultChannel', length: 20, defaultValue: 'stable' },
    {
      type: 'belongsTo',
      name: 'owner',
      target: 'users',
      foreignKey: 'ownerId',
    },
    {
      type: 'belongsTo',
      name: 'latestStableVersion',
      target: 'skillRegistryVersions',
      foreignKey: 'latestStableVersionId',
      onDelete: 'SET NULL',
    },
    { type: 'bigInt', name: 'downloadCount', defaultValue: 0 },
    { type: 'date', name: 'publishedAt', allowNull: true },
    { type: 'belongsTo', name: 'createdBy', target: 'users', foreignKey: 'createdById' },
    { type: 'belongsTo', name: 'updatedBy', target: 'users', foreignKey: 'updatedById' },
  ],
});
