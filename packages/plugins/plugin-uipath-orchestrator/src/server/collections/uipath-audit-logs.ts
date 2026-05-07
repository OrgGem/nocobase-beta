import { CollectionOptions } from '@nocobase/database';

export default {
  name: 'uipathAuditLogs',
  title: 'UiPath Audit Logs',
  fields: [
    { name: 'id', type: 'bigInt', autoIncrement: true, primaryKey: true },
    { name: 'instanceId', type: 'bigInt' },
    { name: 'instance', type: 'belongsTo', target: 'uipathInstances', foreignKey: 'instanceId' },
    // NocoBase user who performed the action
    { name: 'userId', type: 'bigInt' },
    { name: 'userName', type: 'string', length: 200 },
    // Action performed: start_job, stop_job, kill_job, retry_queue_item, create_asset, etc.
    { name: 'action', type: 'string', length: 50 },
    { name: 'resourceType', type: 'string', length: 50 },
    { name: 'resourceId', type: 'string', length: 100 },
    { name: 'folderId', type: 'bigInt' },
    { name: 'folderName', type: 'string', length: 200 },
    // Additional context (JSON)
    { name: 'details', type: 'json' },
    // success | error
    { name: 'status', type: 'string', length: 20, defaultValue: 'success' },
    { name: 'errorMessage', type: 'text' },
    { name: 'createdAt', type: 'date' },
  ],
} as CollectionOptions;
