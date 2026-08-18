import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'selectorEntries',
  title: 'Selector Entries',
  autoGenId: true,
  createdAt: true,
  updatedAt: true,
  indexes: [
    { name: 'selector_entries_identity', fields: ['appId', 'elementKey'], unique: true },
    { name: 'selector_entries_status_used', fields: ['status', 'lastUsedAt'] },
    { name: 'selector_entries_element_key', fields: ['elementKey'] },
  ],
  fields: [
    { type: 'belongsTo', name: 'app', target: 'selectorApps', foreignKey: 'appId', onDelete: 'CASCADE' },
    // sha256 identity hash agreed between client and registry; survives selector changes.
    { type: 'string', name: 'elementKey', length: 64, allowNull: false },
    { type: 'string', name: 'name', length: 200, allowNull: true },
    { type: 'string', name: 'pageUrlPattern', length: 1000, allowNull: true },
    { type: 'text', name: 'currentSelector', allowNull: true },
    { type: 'string', name: 'selectorType', length: 16, defaultValue: 'css' },
    { type: 'json', name: 'fallbackSelectors', defaultValue: [] },
    { type: 'json', name: 'signature', allowNull: true },
    { type: 'string', name: 'status', length: 20, defaultValue: 'probation' },
    // Pinned entries are never overwritten by self-healing.
    { type: 'boolean', name: 'pinned', defaultValue: false },
    { type: 'float', name: 'confidence', defaultValue: 0.5 },
    { type: 'date', name: 'confidenceUpdatedAt', allowNull: true },
    { type: 'bigInt', name: 'hitCount', defaultValue: 0 },
    { type: 'bigInt', name: 'successCount', defaultValue: 0 },
    { type: 'bigInt', name: 'failCount', defaultValue: 0 },
    { type: 'integer', name: 'failStreak', defaultValue: 0 },
    { type: 'integer', name: 'probationSuccessCount', defaultValue: 0 },
    { type: 'integer', name: 'version', defaultValue: 1 },
    { type: 'string', name: 'resolvedBy', length: 20, allowNull: true },
    { type: 'date', name: 'lastUsedAt', allowNull: true },
    { type: 'date', name: 'lastSuccessAt', allowNull: true },
    { type: 'date', name: 'lastFailureAt', allowNull: true },
    { type: 'date', name: 'lastResolvedAt', allowNull: true },
    // Circuit breaker: stop healing this entry until the given instant.
    { type: 'date', name: 'circuitBrokenUntil', allowNull: true },
    { type: 'integer', name: 'healAttempts', defaultValue: 0 },
    { type: 'date', name: 'healWindowStartedAt', allowNull: true },
    { type: 'belongsTo', name: 'createdBy', target: 'users', foreignKey: 'createdById' },
    { type: 'belongsTo', name: 'updatedBy', target: 'users', foreignKey: 'updatedById' },
  ],
});
