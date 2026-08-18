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
      name: 'startedAt',
      type: 'date',
      allowNull: true,
    },
    {
      name: 'heartbeatAt',
      type: 'date',
      allowNull: true,
    },
    {
      name: 'workerId',
      type: 'string',
      length: 200,
      allowNull: true,
    },
    {
      name: 'retryCount',
      type: 'integer',
      defaultValue: 0,
    },
    {
      name: 'sessionId',
      type: 'string',
      length: 100,
      allowNull: true,
    },
    {
      name: 'aiEmployeeUsername',
      type: 'string',
      length: 100,
      allowNull: true,
    },
    {
      name: 'skillToolName',
      type: 'string',
      length: 140,
      allowNull: true,
    },
    {
      // SHA-256 of the exact rendered source stored in executedCode.
      name: 'skillDigest',
      type: 'string',
      length: 64,
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
      // Harness-derived overrides resolved when the execution is queued, e.g.
      // { timeoutSeconds, spillMaxInlineBytes }. The worker applies them on top of the skill's
      // own defaults; storing them here keeps the worker from needing harness access.
      name: 'runtimePolicy',
      type: 'json',
      allowNull: true,
    },
    {
      name: 'createdAt',
      type: 'date',
    },
  ],
} as CollectionOptions;
