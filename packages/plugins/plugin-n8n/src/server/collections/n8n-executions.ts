import { CollectionOptions } from '@nocobase/database';

export default {
  name: 'n8nExecutionHistory',
  title: 'n8n Execution History (local mirror)',
  indexes: [
    { unique: true, fields: ['instanceId', 'executionId'] },
    { fields: ['instanceId', 'startedAt'] },
    { fields: ['instanceId', 'status'] },
  ],
  fields: [
    { name: 'id', type: 'bigInt', autoIncrement: true, primaryKey: true },
    { name: 'instanceId', type: 'bigInt' },
    { name: 'executionId', type: 'string', length: 100 },
    { name: 'workflowId', type: 'string', length: 100 },
    { name: 'workflowName', type: 'string', length: 300 },
    { name: 'status', type: 'string', length: 20 },
    { name: 'mode', type: 'string', length: 30 },
    { name: 'finished', type: 'boolean', defaultValue: false },
    { name: 'startedAt', type: 'date' },
    { name: 'stoppedAt', type: 'date' },
    { name: 'durationMs', type: 'float' },
    { name: 'createdAt', type: 'date' },
    { name: 'updatedAt', type: 'date' },
  ],
} as CollectionOptions;
