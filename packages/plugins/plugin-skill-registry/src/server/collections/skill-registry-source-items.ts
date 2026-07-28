import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'skillRegistrySourceItems',
  title: 'Skill Registry Source Items',
  autoGenId: true,
  createdAt: true,
  updatedAt: true,
  indexes: [
    { name: 'skill_registry_source_items_source_external', fields: ['sourceId', 'externalKey'], unique: true },
    { name: 'skill_registry_source_items_source_state', fields: ['sourceId', 'state'] },
    // One package has one authoritative source item. The nullable unique index
    // is the database backstop when two replicas race past process-local locks.
    { name: 'skill_registry_source_items_package_owner', fields: ['packageId'], unique: true },
    { name: 'skill_registry_source_items_updated', fields: ['updatedAt'] },
    { name: 'skill_registry_source_items_digest', fields: ['candidateDigest'] },
  ],
  fields: [
    {
      type: 'belongsTo',
      name: 'source',
      target: 'skillRegistrySources',
      foreignKey: 'sourceId',
      onDelete: 'RESTRICT',
      allowNull: false,
    },
    {
      type: 'belongsTo',
      name: 'package',
      target: 'skillRegistryPackages',
      foreignKey: 'packageId',
      onDelete: 'RESTRICT',
    },
    { type: 'string', name: 'externalKey', length: 500, allowNull: false },
    { type: 'string', name: 'displayName', length: 200, allowNull: false },
    { type: 'string', name: 'sourceRevision', length: 128, allowNull: false },
    { type: 'string', name: 'candidateDigest', length: 71, allowNull: false },
    { type: 'json', name: 'candidateManifest', defaultValue: {} },
    { type: 'string', name: 'state', length: 24, defaultValue: 'discovered' },
    { type: 'string', name: 'conflictCode', length: 80, allowNull: true },
    { type: 'json', name: 'conflictDetail', allowNull: true },
    { type: 'date', name: 'lastSeenAt', allowNull: false },
  ],
});
