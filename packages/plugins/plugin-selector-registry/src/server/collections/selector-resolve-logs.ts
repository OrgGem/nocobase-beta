import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'selectorResolveLogs',
  title: 'Selector Resolve Logs',
  autoGenId: true,
  createdAt: true,
  updatedAt: false,
  indexes: [
    { name: 'selector_resolve_logs_key_created', fields: ['elementKey', 'createdAt'] },
    { name: 'selector_resolve_logs_app_created', fields: ['appId', 'createdAt'] },
    { name: 'selector_resolve_logs_path', fields: ['path'] },
  ],
  fields: [
    {
      type: 'belongsTo',
      name: 'entry',
      target: 'selectorEntries',
      foreignKey: 'entryId',
      onDelete: 'SET NULL',
    },
    { type: 'bigInt', name: 'appId', allowNull: true },
    { type: 'string', name: 'elementKey', length: 64, allowNull: false },
    { type: 'string', name: 'path', length: 20, allowNull: false },
    { type: 'string', name: 'failureType', length: 30, allowNull: true },
    { type: 'string', name: 'idempotencyKey', length: 128, allowNull: true },
    { type: 'json', name: 'requestPayload', allowNull: true },
    { type: 'json', name: 'responsePayload', allowNull: true },
    { type: 'text', name: 'selectorBefore', allowNull: true },
    { type: 'text', name: 'selectorAfter', allowNull: true },
    { type: 'integer', name: 'durationMs', allowNull: true },
    { type: 'string', name: 'agentId', length: 200, allowNull: true },
    { type: 'string', name: 'clientIp', length: 64, allowNull: true },
  ],
});
