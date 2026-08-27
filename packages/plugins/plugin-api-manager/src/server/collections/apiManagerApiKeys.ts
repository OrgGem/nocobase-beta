import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'apiManagerApiKeys',
  title: 'API Manager API Keys',
  fields: [
    {
      type: 'string',
      name: 'name',
      allowNull: false,
      interface: 'input',
      uiSchema: {
        title: 'Name',
        type: 'string',
        'x-component': 'Input',
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
      type: 'string',
      name: 'keyHash',
      allowNull: false,
      unique: true,
    },
    {
      type: 'string',
      name: 'keyPrefix',
    },
    {
      type: 'json',
      name: 'scopes',
      defaultValue: [],
    },
    {
      type: 'date',
      name: 'expiresAt',
    },
    {
      type: 'date',
      name: 'lastUsedAt',
    },
    {
      type: 'date',
      name: 'revokedAt',
    },
    {
      type: 'boolean',
      name: 'enabled',
      defaultValue: true,
    },
  ],
});
