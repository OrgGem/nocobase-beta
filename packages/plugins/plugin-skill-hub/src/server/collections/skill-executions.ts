import { CollectionOptions } from '@nocobase/database';

export default {
  name: 'skillExecutions',
  title: 'Skill Executions',
  fields: [
    {
      name: 'id',
      type: 'bigInt',
      autoIncrement: true,
      primaryKey: true,
    },
    {
      name: 'skill',
      type: 'belongsTo',
      target: 'skillDefinitions',
      foreignKey: 'skillId',
    },
    {
      // 'pending' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'timeout'
      name: 'status',
      type: 'string',
      length: 20,
      defaultValue: 'pending',
    },
    {
      name: 'inputArgs',
      type: 'json',
    },
    {
      // Final code after template rendering
      name: 'executedCode',
      type: 'text',
    },
    {
      name: 'stdout',
      type: 'text',
    },
    {
      name: 'stderr',
      type: 'text',
    },
    {
      // [{ name, size, mimeType }]
      name: 'outputFiles',
      type: 'json',
      defaultValue: [],
    },
    {
      name: 'durationMs',
      type: 'integer',
    },
    {
      name: 'sessionId',
      type: 'string',
      length: 100,
      allowNull: true,
    },
    {
      name: 'triggeredBy',
      type: 'belongsTo',
      target: 'users',
      foreignKey: 'triggeredById',
    },
    {
      name: 'createdAt',
      type: 'date',
    },
  ],
} as CollectionOptions;
