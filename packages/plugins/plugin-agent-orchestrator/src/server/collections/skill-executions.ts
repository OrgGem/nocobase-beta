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
      type: 'text',
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
      type: 'text',
      defaultValue: null,
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
      name: 'orchestratorRootRunId',
      type: 'string',
      length: 100,
      allowNull: true,
    },
    {
      name: 'orchestratorSpanId',
      type: 'string',
      length: 100,
      allowNull: true,
    },
    {
      name: 'orchestratorParentSpanId',
      type: 'string',
      length: 100,
      allowNull: true,
    },
    {
      name: 'orchestratorToolCallId',
      type: 'string',
      length: 100,
      allowNull: true,
    },
    {
      name: 'agentLoopRunId',
      type: 'string',
      length: 100,
      allowNull: true,
    },
    {
      name: 'agentLoopStepId',
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
