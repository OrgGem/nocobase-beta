import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'skillRegistryMarkdownSkills',
  title: 'Skill Registry Markdown Skills',
  autoGenId: true,
  createdAt: true,
  updatedAt: true,
  indexes: [
    { name: 'skill_registry_md_skills_identity', fields: ['namespace', 'slug'], unique: true },
    { name: 'skill_registry_md_skills_owner', fields: ['ownerId'] },
    { name: 'skill_registry_md_skills_status_updated', fields: ['status', 'updatedAt'] },
  ],
  fields: [
    { type: 'string', name: 'namespace', length: 80, allowNull: false },
    { type: 'string', name: 'slug', length: 120, allowNull: false },
    { type: 'string', name: 'displayName', length: 200, allowNull: false },
    { type: 'text', name: 'description', defaultValue: '' },
    { type: 'text', name: 'content', allowNull: false },
    { type: 'json', name: 'tags', defaultValue: [] },
    { type: 'string', name: 'visibility', length: 16, defaultValue: 'shared' },
    { type: 'string', name: 'status', length: 24, defaultValue: 'draft' },
    {
      type: 'belongsTo',
      name: 'owner',
      target: 'users',
      foreignKey: 'ownerId',
      allowNull: false,
    },
    {
      type: 'belongsTo',
      name: 'package',
      target: 'skillRegistryPackages',
      foreignKey: 'packageId',
      onDelete: 'SET NULL',
    },
    { type: 'belongsTo', name: 'createdBy', target: 'users', foreignKey: 'createdById' },
    { type: 'belongsTo', name: 'updatedBy', target: 'users', foreignKey: 'updatedById' },
  ],
});
