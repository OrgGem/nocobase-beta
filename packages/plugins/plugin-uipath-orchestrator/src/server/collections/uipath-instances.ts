import { CollectionOptions } from '@nocobase/database';

export default {
  name: 'uipathInstances',
  title: 'UiPath Instances',
  fields: [
    { name: 'id', type: 'bigInt', autoIncrement: true, primaryKey: true },
    { name: 'name', type: 'string', length: 200 },
    // cloud | onPrem
    { name: 'deploymentType', type: 'string', length: 20, defaultValue: 'cloud' },
    // Only used for on-prem: full base URL of Orchestrator
    { name: 'baseUrl', type: 'string', length: 500 },
    // Cloud fields
    { name: 'accountLogicalName', type: 'string', length: 200 },
    { name: 'tenantLogicalName', type: 'string', length: 200 },
    { name: 'tenantName', type: 'string', length: 200 },
    // Derived / overridable: {cloudUrl}/{accountLogicalName}/{tenantLogicalName}/orchestrator_
    { name: 'apiBaseUrl', type: 'string', length: 500 },
    // OAuth2 client_credentials
    { name: 'tokenUrl', type: 'text' },
    { name: 'clientId', type: 'text' },
    { name: 'clientSecret', type: 'text' },
    { name: 'scopes', type: 'string', length: 500, defaultValue: 'OR.Default' },
    // Default folder context
    { name: 'defaultFolderId', type: 'bigInt' },
    { name: 'defaultFolderKey', type: 'string', length: 100 },
    { name: 'defaultFolderPath', type: 'string', length: 500 },
    // Options
    { name: 'ignoreSsl', type: 'boolean', defaultValue: false },
    { name: 'enabled', type: 'boolean', defaultValue: true },
    { name: 'isDefault', type: 'boolean', defaultValue: false },
    { name: 'pollEnabled', type: 'boolean', defaultValue: true },
    // Optional: Elasticsearch direct config for advanced log search
    { name: 'esEnabled', type: 'boolean', defaultValue: false },
    { name: 'esNodes', type: 'text' },
    { name: 'esIndex', type: 'string', length: 200, defaultValue: 'default-robotlogs-*' },
    { name: 'esUsername', type: 'string', length: 200 },
    { name: 'esPassword', type: 'text' },
    // Webhook secret for HMAC-SHA256 verification
    { name: 'webhookSecret', type: 'text' },
    { name: 'createdAt', type: 'date' },
    { name: 'updatedAt', type: 'date' },
  ],
} as CollectionOptions;
