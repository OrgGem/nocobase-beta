import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'sftpgoConnections',
  title: 'SFTPGo Connections',
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
      name: 'baseUrl',
      allowNull: false,
      interface: 'input',
      uiSchema: {
        title: 'Base URL',
        type: 'string',
        'x-component': 'Input',
      },
    },
    {
      type: 'string',
      name: 'authMethod',
      defaultValue: 'admin',
      interface: 'select',
      uiSchema: {
        title: 'Auth Method',
        type: 'string',
        'x-component': 'Select',
        enum: [
          { value: 'admin', label: 'Admin (username/password)' },
          { value: 'apikey', label: 'API Key' },
        ],
      },
    },
    {
      type: 'string',
      name: 'username',
      interface: 'input',
      uiSchema: {
        title: 'Username',
        type: 'string',
        'x-component': 'Input',
      },
    },
    {
      type: 'text',
      name: 'password',
      interface: 'password',
      uiSchema: {
        title: 'Password',
        type: 'string',
        'x-component': 'Password',
      },
    },
    {
      type: 'text',
      name: 'apiKey',
      interface: 'password',
      uiSchema: {
        title: 'API Key',
        type: 'string',
        'x-component': 'Password',
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
