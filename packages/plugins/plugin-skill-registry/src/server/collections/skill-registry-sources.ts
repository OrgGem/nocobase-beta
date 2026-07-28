import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'skillRegistrySources',
  title: 'Skill Registry Sources',
  autoGenId: true,
  createdAt: true,
  updatedAt: true,
  indexes: [
    { name: 'skill_registry_sources_provider_name', fields: ['providerType', 'name'], unique: true },
    { name: 'skill_registry_sources_enabled_policy', fields: ['enabled', 'syncPolicy'] },
    { name: 'skill_registry_sources_status_updated', fields: ['status', 'updatedAt'] },
  ],
  fields: [
    { type: 'string', name: 'name', length: 120, allowNull: false },
    { type: 'string', name: 'providerType', length: 40, allowNull: false },
    { type: 'string', name: 'namespace', length: 80, allowNull: false },
    { type: 'json', name: 'providerConfig', defaultValue: {} },
    { type: 'boolean', name: 'enabled', defaultValue: true },
    { type: 'string', name: 'syncPolicy', length: 20, defaultValue: 'manual' },
    { type: 'integer', name: 'syncIntervalMinutes', allowNull: true },
    { type: 'string', name: 'status', length: 24, defaultValue: 'ready' },
    { type: 'string', name: 'lastResolvedRevision', length: 128, allowNull: true },
    { type: 'date', name: 'lastSyncedAt', allowNull: true },
    { type: 'string', name: 'lastErrorCode', length: 80, allowNull: true },
    { type: 'text', name: 'lastErrorMessage', allowNull: true },
    { type: 'belongsTo', name: 'createdBy', target: 'users', foreignKey: 'createdById' },
    { type: 'belongsTo', name: 'updatedBy', target: 'users', foreignKey: 'updatedById' },
  ],
});
