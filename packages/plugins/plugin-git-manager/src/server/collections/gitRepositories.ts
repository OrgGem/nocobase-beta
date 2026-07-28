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
      type: 'belongsTo',
      name: 'gitAccount',
      target: 'gitAccounts',
      foreignKey: 'gitAccountId',
      onDelete: 'RESTRICT',
      interface: 'm2o',
      uiSchema: {
        title: 'Git Account',
        'x-component': 'AssociationField',
        'x-component-props': { fieldNames: { label: 'name', value: 'id' } },
      },
    },
    {
      type: 'string',
      name: 'localPath',
      interface: 'input',
      uiSchema: { title: 'Local Path', type: 'string', 'x-component': 'Input' },
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
      type: 'boolean',
      name: 'registryExportEnabled',
      allowNull: false,
      defaultValue: false,
      interface: 'checkbox',
      uiSchema: { title: 'Allow Skill Registry export', type: 'boolean', 'x-component': 'Checkbox' },
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
