import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'vaultSecretMappings',
  title: 'Vault Secret Mappings',
  fields: [
    {
      type: 'belongsTo',
      name: 'connection',
      target: 'vaultConnections',
      foreignKey: 'connectionId',
      onDelete: 'CASCADE',
    },
    {
      type: 'string',
      name: 'variableKey',
      allowNull: false,
      unique: true,
      interface: 'input',
      uiSchema: {
        title: 'Variable Key',
        type: 'string',
        'x-component': 'Input',
      },
    },
    {
      type: 'string',
      name: 'secretPath',
      allowNull: false,
      interface: 'input',
      uiSchema: {
        title: 'Secret Path',
        type: 'string',
        'x-component': 'Input',
      },
    },
    {
      type: 'string',
      name: 'secretKey',
      allowNull: false,
      interface: 'input',
      uiSchema: {
        title: 'Secret Key',
        type: 'string',
        'x-component': 'Input',
      },
    },
    {
      type: 'boolean',
      name: 'exposeToClient',
      defaultValue: false,
      interface: 'checkbox',
      uiSchema: {
        title: 'Expose To Client',
        type: 'boolean',
        'x-component': 'Checkbox',
      },
    },
    {
      type: 'boolean',
      name: 'syncToEnv',
      defaultValue: false,
      interface: 'checkbox',
      uiSchema: {
        title: 'Sync To $env',
        type: 'boolean',
        'x-component': 'Checkbox',
      },
    },
    {
      type: 'date',
      name: 'lastSyncedAt',
      interface: 'datetime',
      uiSchema: {
        title: 'Last Synced At',
        type: 'string',
        'x-component': 'DatePicker',
        'x-component-props': { showTime: true },
      },
    },
    {
      type: 'text',
      name: 'lastError',
      interface: 'textarea',
      uiSchema: {
        title: 'Last Error',
        type: 'string',
        'x-component': 'Input.TextArea',
      },
    },
  ],
});
