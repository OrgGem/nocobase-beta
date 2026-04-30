import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'gitReviewFlows',
  title: 'Git Review Flows',
  autoGenId: true,
  createdBy: true,
  updatedBy: true,
  createdAt: true,
  updatedAt: true,
  fields: [
    {
      type: 'string',
      name: 'name',
      interface: 'input',
      uiSchema: { title: 'Flow Name', type: 'string', 'x-component': 'Input', required: true },
    },
    {
      type: 'belongsTo',
      name: 'repository',
      target: 'gitRepositories',
      foreignKey: 'repositoryId',
      interface: 'm2o',
      uiSchema: {
        title: 'Repository',
        'x-component': 'AssociationField',
        'x-component-props': { fieldNames: { label: 'name', value: 'id' } },
      },
    },
    {
      type: 'boolean',
      name: 'enabled',
      defaultValue: true,
      interface: 'checkbox',
      uiSchema: { title: 'Enabled', type: 'boolean', 'x-component': 'Checkbox' },
    },
    {
      type: 'string',
      name: 'triggerMode',
      defaultValue: 'manual',
      interface: 'select',
      uiSchema: {
        title: 'Trigger Mode',
        type: 'string',
        'x-component': 'Select',
        enum: [
          { value: 'manual', label: 'Manual' },
          { value: 'onMergeRequestCreated', label: 'On Merge Request Created' },
          { value: 'both', label: 'Both' },
        ],
      },
    },
    {
      type: 'string',
      name: 'aiEmployeeUsername',
      interface: 'input',
      uiSchema: { title: 'AI Employee', type: 'string', 'x-component': 'Input' },
    },
    {
      type: 'string',
      name: 'llmService',
      interface: 'input',
      uiSchema: { title: 'LLM Service (optional)', type: 'string', 'x-component': 'Input' },
    },
    {
      type: 'string',
      name: 'model',
      interface: 'input',
      uiSchema: { title: 'Model (optional)', type: 'string', 'x-component': 'Input' },
    },
    {
      type: 'string',
      name: 'branchFilter',
      interface: 'input',
      uiSchema: {
        title: 'Branch Filter (regex, optional)',
        type: 'string',
        'x-component': 'Input',
      },
    },
    {
      type: 'string',
      name: 'postMode',
      defaultValue: 'manual',
      interface: 'select',
      uiSchema: {
        title: 'Post Mode',
        type: 'string',
        'x-component': 'Select',
        enum: [
          { value: 'auto', label: 'Auto' },
          { value: 'manual', label: 'Manual (require approval)' },
          { value: 'disabled', label: 'Disabled' },
        ],
      },
    },
    {
      type: 'text',
      name: 'instructions',
      interface: 'textarea',
      uiSchema: {
        title: 'Additional Instructions',
        type: 'string',
        'x-component': 'Input.TextArea',
      },
    },
  ],
});
