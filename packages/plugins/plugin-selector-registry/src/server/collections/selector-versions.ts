import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'selectorVersions',
  title: 'Selector Versions',
  autoGenId: true,
  createdAt: true,
  updatedAt: true,
  indexes: [
    { name: 'selector_versions_entry_status', fields: ['entryId', 'status'] },
    { name: 'selector_versions_entry_created', fields: ['entryId', 'createdAt'] },
  ],
  fields: [
    {
      type: 'belongsTo',
      name: 'entry',
      target: 'selectorEntries',
      foreignKey: 'entryId',
      onDelete: 'CASCADE',
    },
    { type: 'text', name: 'selector', allowNull: false },
    { type: 'string', name: 'selectorType', length: 16, defaultValue: 'css' },
    { type: 'string', name: 'source', length: 20, defaultValue: 'manual' },
    { type: 'float', name: 'confidence', defaultValue: 0.5 },
    { type: 'text', name: 'reason', allowNull: true },
    { type: 'json', name: 'signatureAtCapture', allowNull: true },
    { type: 'string', name: 'llmModel', length: 200, allowNull: true },
    { type: 'integer', name: 'promptTokens', allowNull: true },
    { type: 'integer', name: 'completionTokens', allowNull: true },
    { type: 'integer', name: 'latencyMs', allowNull: true },
    { type: 'string', name: 'status', length: 20, defaultValue: 'active' },
    { type: 'bigInt', name: 'successCount', defaultValue: 0 },
    { type: 'bigInt', name: 'failCount', defaultValue: 0 },
    { type: 'date', name: 'rolledBackAt', allowNull: true },
  ],
});
