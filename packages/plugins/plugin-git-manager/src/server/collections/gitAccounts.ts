import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'gitAccounts',
  title: 'Git Accounts',
  autoGenId: true,
  createdAt: true,
  updatedAt: true,
  fields: [
    {
      type: 'string',
      name: 'name',
      interface: 'input',
      uiSchema: { title: 'Account Name', type: 'string', 'x-component': 'Input', required: true },
    },
    {
      type: 'string',
      name: 'provider',
      defaultValue: 'gitlab',
      interface: 'select',
      uiSchema: {
        title: 'Provider',
        type: 'string',
        'x-component': 'Select',
        enum: [
          { value: 'gitlab', label: 'GitLab' },
          { value: 'github', label: 'GitHub' },
        ],
      },
    },
    {
      type: 'string',
      name: 'baseUrl',
      interface: 'input',
      uiSchema: { title: 'Base URL', type: 'string', 'x-component': 'Input' },
    },
    {
      type: 'string',
      name: 'username',
      interface: 'input',
      uiSchema: { title: 'Username', type: 'string', 'x-component': 'Input', required: true },
    },
    {
      type: 'string',
      name: 'pat',
      interface: 'password',
      uiSchema: { title: 'Personal Access Token', type: 'string', 'x-component': 'Password', required: true },
    },
    {
      type: 'hasMany',
      name: 'repositories',
      target: 'gitRepositories',
      foreignKey: 'gitAccountId',
    },
  ],
});
