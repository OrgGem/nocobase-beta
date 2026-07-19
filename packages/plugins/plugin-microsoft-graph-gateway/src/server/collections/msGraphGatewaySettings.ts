import { CollectionOptions } from '@nocobase/database';
export default {
  name: 'msGraphGatewaySettings',
  fields: [
    { name: 'name', type: 'string', unique: true },
    { name: 'tenantId', type: 'string' },
    { name: 'clientId', type: 'string' },
    // Stored as AES ciphertext by the plugin's beforeSave hook. `password`
    // cannot be used because it is a one-way hash and Graph needs the secret.
    { name: 'clientSecret', type: 'text', hidden: true },
    { name: 'maxAttempts', type: 'integer', defaultValue: 5 },
    { name: 'concurrency', type: 'integer', defaultValue: 2 },
  ],
} as CollectionOptions;
