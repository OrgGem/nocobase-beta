import { CollectionOptions } from '@nocobase/database';
export default {
  name: 'msGraphGatewayApiKeys',
  fields: [
    { name: 'name', type: 'string' },
    { name: 'keyHash', type: 'string', unique: true, hidden: true },
    { name: 'scopes', type: 'json' },
    { name: 'enabled', type: 'boolean', defaultValue: true },
    { name: 'expiresAt', type: 'date' },
    { name: 'lastUsedAt', type: 'date' },
  ],
} as CollectionOptions;
