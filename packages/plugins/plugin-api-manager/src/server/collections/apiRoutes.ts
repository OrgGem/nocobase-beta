import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'apiRoutes',
  title: 'API Routes',
  createdBy: true,
  updatedBy: true,
  fields: [
    {
      type: 'string',
      name: 'name',
      allowNull: false,
      unique: true,
      interface: 'input',
      uiSchema: {
        title: 'Name',
        type: 'string',
        'x-component': 'Input',
      },
    },
    {
      type: 'string',
      name: 'direction',
      allowNull: false,
      interface: 'select',
      uiSchema: {
        title: 'Direction',
        type: 'string',
        'x-component': 'Select',
        enum: [
          { value: 'inbound', label: 'Inbound' },
          { value: 'outbound', label: 'Outbound' },
        ],
      },
    },
    {
      type: 'bigInt',
      name: 'partnerId',
      index: true,
    },
    {
      type: 'belongsTo',
      name: 'partner',
      target: 'apiPartners',
      foreignKey: 'partnerId',
    },
    {
      type: 'text',
      name: 'description',
      interface: 'textarea',
      uiSchema: {
        title: 'Description',
        type: 'string',
        'x-component': 'Input.TextArea',
      },
    },
    {
      type: 'boolean',
      name: 'enabled',
      defaultValue: true,
      interface: 'checkbox',
      uiSchema: {
        title: 'Enabled',
        type: 'boolean',
        'x-component': 'Checkbox',
      },
    },
    {
      type: 'string',
      name: 'method',
      allowNull: false,
      defaultValue: 'POST',
      interface: 'select',
      uiSchema: {
        title: 'Method',
        type: 'string',
        'x-component': 'Select',
        enum: [
          { value: 'GET', label: 'GET' },
          { value: 'POST', label: 'POST' },
          { value: 'PUT', label: 'PUT' },
          { value: 'PATCH', label: 'PATCH' },
          { value: 'DELETE', label: 'DELETE' },
        ],
      },
    },
    {
      type: 'string',
      name: 'inboundPath',
      interface: 'input',
      uiSchema: {
        title: 'Inbound Path',
        type: 'string',
        'x-component': 'Input',
      },
    },
    {
      type: 'text',
      name: 'targetUrl',
      allowNull: false,
      interface: 'input',
      uiSchema: {
        title: 'Target URL',
        type: 'string',
        'x-component': 'Input',
      },
    },
    {
      type: 'string',
      name: 'encryptionMode',
      allowNull: false,
      defaultValue: 'none',
      interface: 'select',
      uiSchema: {
        title: 'Encryption',
        type: 'string',
        'x-component': 'Select',
        enum: [
          { value: 'none', label: 'None' },
          { value: 'aes-256-gcm', label: 'AES-256-GCM' },
          { value: 'pgp', label: 'PGP' },
        ],
      },
    },
    {
      type: 'string',
      name: 'wireFormat',
      allowNull: false,
      defaultValue: 'binary',
      interface: 'select',
      uiSchema: {
        title: 'Wire Format',
        type: 'string',
        'x-component': 'Select',
        enum: [
          { value: 'binary', label: 'Binary' },
          { value: 'json', label: 'JSON' },
        ],
      },
    },
    {
      type: 'text',
      name: 'aesSecret',
    },
    {
      type: 'string',
      name: 'aesSecretEnvVar',
      interface: 'input',
      uiSchema: {
        title: 'AES Secret Env Variable',
        type: 'string',
        'x-component': 'Input',
      },
    },
    {
      type: 'string',
      name: 'pgpEncryptKeyName',
      interface: 'input',
      uiSchema: {
        title: 'PGP Encrypt Key',
        type: 'string',
        'x-component': 'Input',
      },
    },
    {
      type: 'string',
      name: 'pgpDecryptKeyName',
      interface: 'input',
      uiSchema: {
        title: 'PGP Decrypt Key',
        type: 'string',
        'x-component': 'Input',
      },
    },
    {
      type: 'string',
      name: 'pgpSignKeyName',
      interface: 'input',
      uiSchema: {
        title: 'PGP Sign Key',
        type: 'string',
        'x-component': 'Input',
      },
    },
    {
      type: 'string',
      name: 'pgpVerifyKeyName',
      interface: 'input',
      uiSchema: {
        title: 'PGP Verify Key',
        type: 'string',
        'x-component': 'Input',
      },
    },
    {
      type: 'integer',
      name: 'timeoutMs',
      defaultValue: 30000,
    },
    {
      type: 'integer',
      name: 'retryCount',
      defaultValue: 0,
    },
    {
      type: 'integer',
      name: 'retryDelayMs',
      defaultValue: 1000,
    },
    {
      type: 'boolean',
      name: 'logPayloads',
      defaultValue: false,
    },
    {
      type: 'json',
      name: 'forwardHeaders',
      defaultValue: [],
    },
    {
      type: 'json',
      name: 'staticHeaders',
      defaultValue: [],
    },
    {
      type: 'integer',
      name: 'maxBodyMb',
      defaultValue: 10,
    },
  ],
});
