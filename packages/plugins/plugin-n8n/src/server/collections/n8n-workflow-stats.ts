import { CollectionOptions } from '@nocobase/database';

export default {
  name: 'n8nWorkflowStats',
  title: 'n8n Workflow Stats',
  indexes: [{ unique: true, fields: ['instanceId', 'workflowId'] }],
  fields: [
    { name: 'id', type: 'bigInt', autoIncrement: true, primaryKey: true },
    { name: 'instanceId', type: 'bigInt' },
    { name: 'workflowId', type: 'string', length: 100 },
    { name: 'name', type: 'string', length: 300 },
    { name: 'active', type: 'boolean', defaultValue: false },
    { name: 'totalRuns', type: 'integer', defaultValue: 0 },
    { name: 'successCount', type: 'integer', defaultValue: 0 },
    { name: 'errorCount', type: 'integer', defaultValue: 0 },
    { name: 'finishedCount', type: 'integer', defaultValue: 0 },
    { name: 'totalDurationMs', type: 'float', defaultValue: 0 },
    { name: 'lastRunAt', type: 'date' },
    { name: 'lastStatus', type: 'string', length: 20 },
    { name: 'lastExecutionId', type: 'string', length: 100 },
    { name: 'createdAt', type: 'date' },
    { name: 'updatedAt', type: 'date' },
  ],
} as CollectionOptions;
