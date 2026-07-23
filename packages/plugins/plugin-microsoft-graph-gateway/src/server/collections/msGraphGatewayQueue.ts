import { CollectionOptions } from '@nocobase/database';
export default {
  name: 'msGraphGatewayQueue',
  fields: [
    { name: 'jobId', type: 'uid', prefix: 'mg_' },
    { name: 'operation', type: 'string' },
    { name: 'status', type: 'string', defaultValue: 'pending' },
    { name: 'payload', type: 'json' },
    { name: 'idempotencyKey', type: 'string', unique: true },
    { name: 'attempts', type: 'integer', defaultValue: 0 },
    { name: 'nextAttemptAt', type: 'date' },
    { name: 'lastError', type: 'text' },
    { name: 'graphRequestId', type: 'string' },
    { name: 'result', type: 'json' },
    { name: 'startedAt', type: 'date' },
    { name: 'finishedAt', type: 'date' },
    { name: 'lockedBy', type: 'string' },
  ],
} as CollectionOptions;
