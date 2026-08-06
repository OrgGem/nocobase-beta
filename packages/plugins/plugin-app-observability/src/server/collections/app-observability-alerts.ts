import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'appObservabilityAlerts',
  dataCategory: 'runtime',
  indexes: [{ fields: ['status', 'createdAt'] }, { fields: ['nodeId', 'createdAt'] }],
  fields: [
    { name: 'appName', type: 'string' },
    { name: 'nodeId', type: 'string' },
    { name: 'state', type: 'string' },
    { name: 'status', type: 'string', defaultValue: 'open' },
    { name: 'confidence', type: 'double' },
    { name: 'constrainingSignal', type: 'string' },
    { name: 'evidence', type: 'json' },
    { name: 'recommendation', type: 'text' },
    { name: 'resolvedAt', type: 'date' },
  ],
});
