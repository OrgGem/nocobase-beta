import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'subAgents',
  title: 'Sub Agents',
  sortable: true,
  fields: [
    {
      name: 'name',
      type: 'string',
      title: 'Name',
      required: true,
      unique: true,
    },
    {
      name: 'description',
      type: 'text',
      title: 'Agent Description',
      description: 'Describe what this agent does (acts as tool description)',
    },
    {
      name: 'systemPrompt',
      type: 'text',
      title: 'System Prompt',
    },
    {
      name: 'skills',
      type: 'json',
      title: 'Skills (Tools)',
      defaultValue: [],
    },
    {
      name: 'model',
      type: 'string',
      title: 'LLM Model (Optional)',
    },
    {
      name: 'maxIterations',
      type: 'integer',
      title: 'Max Iterations',
      defaultValue: 10,
    },
    {
      name: 'enabled',
      type: 'boolean',
      title: 'Enabled',
      defaultValue: true,
    },
    {
      name: 'retryOnError',
      type: 'boolean',
      title: 'Retry On Error',
      defaultValue: false,
    },
    {
      name: 'retryCount',
      type: 'integer',
      title: 'Retry Count',
      defaultValue: 3,
    },
  ],
});
