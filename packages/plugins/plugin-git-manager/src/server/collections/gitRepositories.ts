import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'gitRepositories',
  title: 'Git Repositories',
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
      name: 'localPath',
      interface: 'input',
      uiSchema: { title: 'Local Path', type: 'string', 'x-component': 'Input' },
    },
    {
      type: 'password',
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
  ],
});
