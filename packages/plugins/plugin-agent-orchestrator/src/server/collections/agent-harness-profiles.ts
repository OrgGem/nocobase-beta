import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'agentHarnessProfiles',
  title: 'Agent Harness Profiles',
  fields: [
    {
      name: 'id',
      type: 'bigInt',
      autoIncrement: true,
      primaryKey: true,
    },
    {
      name: 'tag',
      type: 'string',
      length: 100,
      allowNull: false,
      unique: true,
      comment: 'Stable harness profile tag used by orchestration rules and agent loop runs.',
    },
    {
      name: 'title',
      type: 'string',
      length: 200,
    },
    {
      name: 'description',
      type: 'text',
    },
    {
      name: 'enabled',
      type: 'boolean',
      defaultValue: true,
    },
    {
      name: 'settings',
      type: 'json',
      defaultValue: {},
      comment: 'Harness limits and behavior settings such as max parallel sub-agents, approval mode, and tool policy.',
    },
    {
      name: 'createdAt',
      type: 'date',
    },
    {
      name: 'updatedAt',
      type: 'date',
    },
  ],
  indexes: [
    {
      unique: true,
      fields: ['tag'],
    },
    {
      fields: ['enabled'],
    },
  ],
});
