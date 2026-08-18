import { CollectionOptions } from '@nocobase/database';

export default {
  name: 'n8nInstances',
  title: 'n8n Instances',
  fields: [
    { name: 'id', type: 'bigInt', autoIncrement: true, primaryKey: true },
    { name: 'name', type: 'string', length: 200 },
    { name: 'baseUrl', type: 'string', length: 500 },
    { name: 'apiKey', type: 'text' },
    { name: 'environment', type: 'string', length: 20, defaultValue: 'production' },
    { name: 'isDefault', type: 'boolean', defaultValue: false },
    { name: 'metricsEnabled', type: 'boolean', defaultValue: false },
    { name: 'internalUrl', type: 'string', length: 500 },
    { name: 'enabled', type: 'boolean', defaultValue: true },
    { name: 'createdAt', type: 'date' },
    { name: 'updatedAt', type: 'date' },
    { name: 'workers', type: 'json' },
    // Collector settings
    { name: 'collectEnabled', type: 'boolean', defaultValue: true },
    { name: 'collectIntervalSeconds', type: 'integer', defaultValue: 60 },
    { name: 'retentionDays', type: 'integer', defaultValue: 7 },
    // Collector state
    { name: 'lastCollectedAt', type: 'date' },
    { name: 'lastExecSyncAt', type: 'date' },
    { name: 'lastWorkflowSyncAt', type: 'date' },
    { name: 'lastHealthStatus', type: 'string', length: 20 },
    { name: 'lastHealthLatency', type: 'float' },
    { name: 'totalWorkflows', type: 'integer', defaultValue: 0 },
    { name: 'activeWorkflows', type: 'integer', defaultValue: 0 },
    { name: 'workerStatus', type: 'json' },
    { name: 'lastWorkerCheckAt', type: 'date' },
  ],
} as CollectionOptions;
