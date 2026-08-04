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
      name: 'schemaVersion',
      type: 'integer',
      allowNull: false,
      defaultValue: 1,
    },
    {
      name: 'currentVersion',
      type: 'belongsTo',
      target: 'agentHarnessProfileVersions',
      foreignKey: 'currentVersionId',
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
