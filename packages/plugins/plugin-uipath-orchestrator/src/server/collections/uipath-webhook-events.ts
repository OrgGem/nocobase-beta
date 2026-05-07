import { CollectionOptions } from '@nocobase/database';

export default {
  name: 'uipathWebhookEvents',
  title: 'UiPath Webhook Events',
  fields: [
    { name: 'id', type: 'bigInt', autoIncrement: true, primaryKey: true },
    { name: 'instanceId', type: 'bigInt' },
    { name: 'instance', type: 'belongsTo', target: 'uipathInstances', foreignKey: 'instanceId' },
    // Event type: job.faulted, job.completed, queueItem.transactionFailed, etc.
    { name: 'eventType', type: 'string', length: 100 },
    { name: 'eventId', type: 'string', length: 100 },
    { name: 'tenantId', type: 'string', length: 100 },
    { name: 'folderId', type: 'bigInt' },
    // Raw webhook payload
    { name: 'payload', type: 'json' },
    // processed | pending | error
    { name: 'status', type: 'string', length: 20, defaultValue: 'pending' },
    { name: 'processedAt', type: 'date' },
    { name: 'createdAt', type: 'date' },
  ],
} as CollectionOptions;
