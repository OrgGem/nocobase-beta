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
      comment: 'Stable policy profile tag used by native sub-agent observer and context injection.',
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
      comment: 'Policy settings such as native observer enablement, memory scopes, and tracing retention.',
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
