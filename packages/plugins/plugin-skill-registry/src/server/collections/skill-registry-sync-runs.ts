import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'skillRegistrySyncRuns',
  title: 'Skill Registry Sync Runs',
  autoGenId: true,
  createdAt: true,
  indexes: [
    { name: 'skill_registry_sync_runs_active', fields: ['activeKey'], unique: true },
    { name: 'skill_registry_sync_runs_source_created', fields: ['sourceId', 'createdAt'] },
    { name: 'skill_registry_sync_runs_status_created', fields: ['status', 'createdAt'] },
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
    // NULL for completed rows. While a run is active, sourceId is copied here so the
    // database remains the final concurrency guard if a distributed lock lease expires.
    { type: 'string', name: 'activeKey', length: 64, allowNull: true, hidden: true },
    {
      type: 'string',
      name: 'fencingToken',
      length: 64,
      allowNull: true,
      hidden: true,
    },
    { type: 'date', name: 'heartbeatAt', allowNull: true, hidden: true },
    { type: 'string', name: 'triggerType', length: 20, allowNull: false },
    { type: 'string', name: 'status', length: 20, defaultValue: 'queued' },
    { type: 'string', name: 'resolvedRevision', length: 128, allowNull: true },
    { type: 'integer', name: 'discoveredCount', defaultValue: 0 },
    { type: 'integer', name: 'changedCount', defaultValue: 0 },
    { type: 'integer', name: 'conflictCount', defaultValue: 0 },
    { type: 'integer', name: 'blockedCount', defaultValue: 0 },
    { type: 'integer', name: 'errorCount', defaultValue: 0 },
    { type: 'string', name: 'errorCode', length: 80, allowNull: true },
    { type: 'text', name: 'errorMessage', allowNull: true },
    { type: 'json', name: 'details', allowNull: true },
    { type: 'belongsTo', name: 'requestedBy', target: 'users', foreignKey: 'requestedById' },
    { type: 'date', name: 'startedAt', allowNull: true },
    { type: 'date', name: 'finishedAt', allowNull: true },
  ],
});
