import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'gitRepositories',
  title: 'Git Repositories',
  autoGenId: true,
  createdAt: true,
  updatedAt: true,
  fields: [
    {
      type: 'string',
      name: 'name',
      interface: 'input',
      uiSchema: { title: 'Repository Name', type: 'string', 'x-component': 'Input' },
    },
    {
      type: 'string',
      name: 'repoUrl',
      interface: 'input',
      uiSchema: { title: 'Repository URL', type: 'string', 'x-component': 'Input' },
    },
    {
      type: 'string',
      name: 'username',
      interface: 'input',
      uiSchema: { title: 'Username', type: 'string', 'x-component': 'Input' },
    },
    {
      type: 'string',
      name: 'localPath',
      interface: 'input',
      uiSchema: { title: 'Local Path', type: 'string', 'x-component': 'Input' },
    },
    {
      type: 'string',
      name: 'pat',
      interface: 'password',
      uiSchema: { title: 'Personal Access Token', type: 'string', 'x-component': 'Password' },
    },
    {
      type: 'string',
      name: 'defaultBranch',
      defaultValue: 'main',
      interface: 'input',
      uiSchema: { title: 'Default Branch', type: 'string', 'x-component': 'Input' },
    },
    {
      type: 'string',
      name: 'status',
      defaultValue: 'disconnected',
      interface: 'input',
    },
    {
      type: 'boolean',
      name: 'autoReview',
      defaultValue: false,
      interface: 'checkbox',
      uiSchema: { title: 'Auto Review', type: 'boolean', 'x-component': 'Checkbox' },
    },
    {
      type: 'belongsTo',
      name: 'autoReviewFlow',
      target: 'gitReviewFlows',
      foreignKey: 'autoReviewFlowId',
      interface: 'm2o',
      uiSchema: {
        title: 'Primary Auto Review Flow',
        'x-component': 'AssociationField',
        'x-component-props': { fieldNames: { label: 'name', value: 'id' } },
      },
    },
    {
      type: 'date',
      name: 'lastPolledAt',
      interface: 'datetime',
    },
  ],
});
