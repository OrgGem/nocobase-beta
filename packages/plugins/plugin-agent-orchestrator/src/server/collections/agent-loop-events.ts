import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'agentLoopEvents',
  title: 'Agent Loop Events',
  fields: [
    {
      name: 'id',
      type: 'bigInt',
      autoIncrement: true,
      primaryKey: true,
    },
    {
      name: 'run',
      type: 'belongsTo',
      target: 'agentLoopRuns',
      foreignKey: 'runId',
    },
    {
      name: 'step',
      type: 'belongsTo',
      target: 'agentLoopSteps',
      foreignKey: 'stepId',
    },
    {
      name: 'type',
      type: 'string',
      length: 80,
    },
    {
      name: 'title',
      type: 'string',
      length: 500,
    },
    {
      name: 'content',
      type: 'text',
    },
    {
      name: 'status',
      type: 'string',
      length: 30,
    },
    {
      name: 'payload',
      type: 'json',
      defaultValue: {},
    },
    {
      name: 'user',
      type: 'belongsTo',
      target: 'users',
      foreignKey: 'userId',
    },
    {
      name: 'createdAt',
      type: 'date',
    },
  ],
  indexes: [
    {
      fields: ['runId'],
    },
    {
      fields: ['stepId'],
    },
    {
      fields: ['type'],
    },
  ],
});
