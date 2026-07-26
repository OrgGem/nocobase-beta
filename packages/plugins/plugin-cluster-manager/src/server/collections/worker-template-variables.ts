import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'workerTemplateVariables',
  title: 'Worker template variables',
  filterTargetKey: 'id',
  fields: [
    { name: 'key', type: 'string', allowNull: false, index: true },
    { name: 'value', type: 'text' },
    // NocoBase 2.1.x does not register the `encryption` field type in every
    // installation. Store AES-GCM ciphertext here instead.
    { name: 'secretValue', type: 'text', hidden: true },
    {
      name: 'valueType',
      type: 'string',
      defaultValue: 'string',
      interface: 'select',
      uiSchema: {
        title: 'Value type',
        'x-component': 'Select',
        enum: ['string', 'number', 'boolean', 'json', 'secret'].map((value) => ({ value, label: value })),
      },
    },
    {
      name: 'category',
      type: 'string',
      defaultValue: 'custom',
      interface: 'select',
      uiSchema: {
        title: 'Category',
        'x-component': 'Select',
        enum: ['identity', 'readiness', 'runtime', 'logging', 'registry', 'custom'].map((value) => ({
          value,
          label: value,
        })),
      },
    },
    { name: 'scope', type: 'string', defaultValue: 'global', index: true },
    {
      name: 'stack',
      type: 'belongsTo',
      target: 'orchestratorStacks',
      foreignKey: 'stackId',
      onDelete: 'CASCADE',
    },
    { name: 'description', type: 'text' },
    { name: 'defaultValue', type: 'text' },
    { name: 'required', type: 'boolean', defaultValue: false },
    { name: 'systemManaged', type: 'boolean', defaultValue: false },
    { name: 'overridable', type: 'boolean', defaultValue: true },
    { name: 'secret', type: 'boolean', defaultValue: false },
    { name: 'enabled', type: 'boolean', defaultValue: true },
    { name: 'sort', type: 'integer', defaultValue: 0 },
  ],
});
