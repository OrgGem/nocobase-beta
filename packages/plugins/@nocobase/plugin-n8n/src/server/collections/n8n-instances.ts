import { CollectionOptions } from '@nocobase/database';

export default {
  name: 'n8nInstances',
  title: 'n8n Instances',
  fields: [
    { name: 'id', type: 'bigInt', autoIncrement: true, primaryKey: true },
    { name: 'name', type: 'string', length: 200 },
    { name: 'baseUrl', type: 'string', length: 500 },
    { name: 'apiKey', type: 'password', length: 500 },
    { name: 'environment', type: 'string', length: 20, defaultValue: 'production' },
    { name: 'isDefault', type: 'boolean', defaultValue: false },
    { name: 'metricsEnabled', type: 'boolean', defaultValue: false },
    { name: 'internalUrl', type: 'string', length: 500 },
    { name: 'enabled', type: 'boolean', defaultValue: true },
    { name: 'createdAt', type: 'date' },
    { name: 'updatedAt', type: 'date' },
  ],
} as CollectionOptions;
