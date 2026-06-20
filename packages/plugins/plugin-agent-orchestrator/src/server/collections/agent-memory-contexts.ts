import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'agentMemoryContexts',
  title: 'Agent Memory Contexts',
  fields: [
    {
      name: 'id',
      type: 'bigInt',
      autoIncrement: true,
      primaryKey: true,
    },
    {
      name: 'scope',
      type: 'string',
      length: 30,
      allowNull: false,
      comment: 'public, user, or agent_user',
    },
    {
      name: 'contextKey',
      type: 'string',
      length: 300,
      allowNull: false,
      comment: 'Normalized unique key: scope:userId:aiEmployeeUsername.',
    },
    {
      name: 'userId',
      type: 'bigInt',
      comment: 'Null for public agent knowledge; required for user/private scopes.',
    },
    {
      name: 'user',
      type: 'belongsTo',
      target: 'users',
      targetKey: 'id',
      foreignKey: 'userId',
    },
    {
      name: 'aiEmployeeUsername',
      type: 'string',
      length: 100,
      comment: 'Target AI employee username; null/empty means shared within the scope.',
    },
    {
      name: 'contentMd',
      type: 'text',
      comment: 'Markdown facts, preferences, or operating notes for the agent context.',
    },
    {
      name: 'graphMd',
      type: 'text',
      comment: 'Markdown graph or relationship notes for the agent context.',
    },
    {
      name: 'enabled',
      type: 'boolean',
      defaultValue: true,
    },
    {
      name: 'metadata',
      type: 'json',
      defaultValue: {},
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
      fields: ['contextKey'],
    },
    {
      fields: ['scope', 'userId', 'aiEmployeeUsername'],
    },
    {
      fields: ['scope'],
    },
    {
      fields: ['userId'],
    },
    {
      fields: ['aiEmployeeUsername'],
    },
    {
      fields: ['enabled'],
    },
  ],
});
