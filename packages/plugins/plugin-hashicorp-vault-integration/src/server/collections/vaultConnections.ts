import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'vaultConnections',
  title: 'Vault Connections',
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
      name: 'title',
      interface: 'input',
      uiSchema: {
        title: 'Title',
        type: 'string',
        'x-component': 'Input',
      },
    },
    {
      type: 'string',
      name: 'address',
      allowNull: false,
      interface: 'input',
      uiSchema: {
        title: 'Vault Address',
        type: 'string',
        'x-component': 'Input',
      },
    },
    {
      type: 'string',
      name: 'namespace',
      interface: 'input',
      uiSchema: {
        title: 'Namespace',
        type: 'string',
        'x-component': 'Input',
      },
    },
    {
      type: 'string',
      name: 'authMethod',
      defaultValue: 'token',
      interface: 'select',
      uiSchema: {
        title: 'Auth Method',
        type: 'string',
        'x-component': 'Select',
        enum: [
          { value: 'token', label: 'Token' },
          { value: 'approle', label: 'AppRole' },
        ],
      },
    },
    {
      type: 'text',
      name: 'token',
      interface: 'password',
      uiSchema: {
        title: 'Token',
        type: 'string',
        'x-component': 'Password',
      },
    },
    {
      type: 'string',
      name: 'roleId',
      interface: 'input',
      uiSchema: {
        title: 'Role ID',
        type: 'string',
        'x-component': 'Input',
      },
    },
    {
      type: 'text',
      name: 'secretId',
      interface: 'password',
      uiSchema: {
        title: 'Secret ID',
        type: 'string',
        'x-component': 'Password',
      },
    },
    {
      type: 'integer',
      name: 'kvVersion',
      defaultValue: 2,
      interface: 'integer',
      uiSchema: {
        title: 'KV Version',
        type: 'number',
        'x-component': 'InputNumber',
      },
    },
    {
      type: 'string',
      name: 'mount',
      defaultValue: 'secret',
      interface: 'input',
      uiSchema: {
        title: 'KV Mount',
        type: 'string',
        'x-component': 'Input',
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
      type: 'date',
      name: 'lastCheckAt',
      interface: 'datetime',
      uiSchema: {
        title: 'Last Check At',
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
