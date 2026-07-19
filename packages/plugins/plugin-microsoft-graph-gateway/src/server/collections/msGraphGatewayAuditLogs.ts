import { CollectionOptions } from '@nocobase/database';
export default {
  name: 'msGraphGatewayAuditLogs',
  fields: [
    { name: 'requestId', type: 'string', index: true },
    { name: 'jobId', type: 'string', index: true },
    { name: 'operation', type: 'string' },
    { name: 'status', type: 'string' },
    { name: 'httpStatus', type: 'integer' },
    { name: 'graphRequestId', type: 'string' },
    { name: 'details', type: 'json' },
  ],
} as CollectionOptions;
