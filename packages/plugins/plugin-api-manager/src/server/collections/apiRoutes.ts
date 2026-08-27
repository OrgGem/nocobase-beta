import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'apiRoutes',
  title: 'API Routes',
  // Enforce inboundPath uniqueness at the DB level so two inbound routes can
  // never claim the same public path (the beforeSave check alone races).
  indexes: [
    {
      unique: true,
      fields: ['direction', 'inboundPath'],
    },
  ],
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
      allowNull: false,
      index: true,
      interface: 'number',
      uiSchema: {
        title: 'Partner',
        type: 'number',
        'x-component': 'InputNumber',
        required: true,
      },
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
      name: 'authMode',
      allowNull: false,
      defaultValue: 'both',
      interface: 'select',
      uiSchema: {
        title: 'Auth Mode',
        type: 'string',
        'x-component': 'Select',
        enum: [
          { value: 'both', label: 'API Key + Role' },
          { value: 'api-key', label: 'API Key only' },
          { value: 'role', label: 'Role (app token) only' },
        ],
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
          { value: 'rsa-oaep', label: 'RSA-OAEP (hybrid)' },
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
      type: 'string',
      name: 'rsaEncryptKeyName',
      interface: 'input',
      uiSchema: {
        title: 'RSA Encrypt Key',
        type: 'string',
        'x-component': 'Input',
      },
    },
    {
      type: 'string',
      name: 'rsaDecryptKeyName',
      interface: 'input',
      uiSchema: {
        title: 'RSA Decrypt Key',
        type: 'string',
        'x-component': 'Input',
      },
    },
    {
      type: 'boolean',
      name: 'responseEncrypted',
      defaultValue: true,
      interface: 'checkbox',
      uiSchema: {
        title: 'Response Encrypted',
        type: 'boolean',
        'x-component': 'Checkbox',
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
      type: 'json',
      name: 'forwardResponseHeaders',
      defaultValue: [],
      uiSchema: {
        title: 'Forward Response Headers',
        type: 'array',
        'x-component': 'Select',
        'x-component-props': { mode: 'tags' },
        'x-decorator': 'FormItem',
        enum: [
          { value: 'content-disposition', label: 'Content-Disposition' },
          { value: 'content-length', label: 'Content-Length' },
          { value: 'etag', label: 'ETag' },
          { value: 'accept-ranges', label: 'Accept-Ranges' },
          { value: 'last-modified', label: 'Last-Modified' },
          { value: 'content-encoding', label: 'Content-Encoding' },
          { value: 'cache-control', label: 'Cache-Control' },
          { value: 'expires', label: 'Expires' },
        ],
      },
    },
    {
      type: 'integer',
      name: 'maxBodyMb',
      defaultValue: 10,
    },
    // --- HMAC request signing ---
    {
      type: 'boolean',
      name: 'hmacSignEnabled',
      defaultValue: false,
    },
    {
      type: 'boolean',
      name: 'hmacVerifyEnabled',
      defaultValue: false,
    },
    {
      type: 'text',
      name: 'hmacSecret',
    },
    {
      type: 'string',
      name: 'hmacSecretEnvVar',
    },
    {
      type: 'integer',
      name: 'hmacToleranceSec',
      defaultValue: 300,
    },
    // --- JWT auth ---
    {
      type: 'boolean',
      name: 'jwtSignEnabled',
      defaultValue: false,
    },
    {
      type: 'string',
      name: 'jwtSignAlgorithm',
      defaultValue: 'RS256',
    },
    {
      type: 'string',
      name: 'jwtSignKeyName',
    },
    {
      type: 'boolean',
      name: 'jwtVerifyEnabled',
      defaultValue: false,
    },
    {
      type: 'string',
      name: 'jwtVerifyKeyName',
    },
    {
      type: 'text',
      name: 'jwtSecret',
    },
    {
      type: 'string',
      name: 'jwtSecretEnvVar',
    },
    {
      type: 'string',
      name: 'jwtIssuer',
    },
    {
      type: 'string',
      name: 'jwtAudience',
    },
    {
      type: 'integer',
      name: 'jwtExpiresInSec',
      defaultValue: 300,
    },
    // --- Rate limiting ---
    {
      type: 'boolean',
      name: 'rateLimitEnabled',
      defaultValue: false,
    },
    {
      type: 'integer',
      name: 'rateLimitMax',
      defaultValue: 60,
    },
    {
      type: 'integer',
      name: 'rateLimitWindowSec',
      defaultValue: 60,
    },
    // --- IP allowlist ---
    {
      type: 'json',
      name: 'ipAllowlist',
      defaultValue: [],
    },
  ],
});
