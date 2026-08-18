import { CollectionOptions } from '@nocobase/database';

export default {
  name: 'n8nExecutionHourly',
  title: 'n8n Execution Hourly Rollup',
  indexes: [
    { unique: true, fields: ['instanceId', 'workflowId', 'hourBucket'] },
    { fields: ['instanceId', 'hourBucket'] },
  ],
  fields: [
    { name: 'id', type: 'bigInt', autoIncrement: true, primaryKey: true },
    { name: 'instanceId', type: 'bigInt' },
    { name: 'workflowId', type: 'string', length: 100 },
    { name: 'workflowName', type: 'string', length: 300 },
    { name: 'hourBucket', type: 'date' },
    { name: 'success', type: 'integer', defaultValue: 0 },
    { name: 'error', type: 'integer', defaultValue: 0 },
    { name: 'running', type: 'integer', defaultValue: 0 },
    { name: 'waiting', type: 'integer', defaultValue: 0 },
    { name: 'finishedCount', type: 'integer', defaultValue: 0 },
    { name: 'totalDurationMs', type: 'float', defaultValue: 0 },
  ],
} as CollectionOptions;
