import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'agentLoopSteps',
  title: 'Agent Loop Steps',
  fields: [
    {
      name: 'id',
      type: 'bigInt',
      autoIncrement: true,
      primaryKey: true,
    },
    {
      name: 'runId',
      type: 'bigInt',
    },
    {
      name: 'run',
      type: 'belongsTo',
      target: 'agentLoopRuns',
      foreignKey: 'runId',
    },
    {
      name: 'parentStep',
      type: 'belongsTo',
      target: 'agentLoopSteps',
      foreignKey: 'parentStepId',
    },
    {
      name: 'planKey',
      type: 'string',
      length: 100,
    },
    {
      name: 'runtimeVersion',
      type: 'string',
      length: 40,
      defaultValue: 'control-plane-v2',
    },
    {
      name: 'sequence',
      type: 'integer',
      defaultValue: 0,
    },
    {
      name: 'role',
      type: 'string',
      length: 30,
    },
    {
      name: 'kind',
      type: 'string',
      length: 30,
    },
    {
      name: 'employeeUsername',
      type: 'string',
      length: 100,
    },
    {
      name: 'toolName',
      type: 'string',
      length: 200,
    },
    {
      name: 'toolCallId',
      type: 'string',
      length: 200,
    },
    {
      // The AI conversation an invocation step drove; lets run-level guards (tool loop
      // detection) enumerate every session belonging to the run.
      name: 'sessionId',
      type: 'uuid',
      allowNull: true,
    },
    {
      name: 'inputHash',
      type: 'string',
      length: 128,
    },
    {
      name: 'policyDecision',
      type: 'json',
      defaultValue: {},
    },
    {
      name: 'errorSignature',
      type: 'string',
      length: 300,
    },
    {
      name: 'evidenceArtifactIds',
      type: 'json',
      defaultValue: [],
    },
    {
      name: 'index',
      type: 'integer',
      defaultValue: 0,
    },
    {
      name: 'title',
      type: 'string',
      length: 500,
    },
    {
      name: 'description',
      type: 'text',
    },
    {
      name: 'type',
      type: 'string',
      length: 30,
      comment: 'reasoning, skill, tool, sub_agent, verification',
    },
    {
      name: 'target',
      type: 'string',
      length: 200,
    },
    {
      name: 'input',
      type: 'json',
      defaultValue: {},
    },
    {
      name: 'output',
      type: 'json',
      defaultValue: {},
    },
    {
      name: 'status',
      type: 'string',
      length: 30,
      defaultValue: 'pending',
      comment: 'pending, running, waiting_user, succeeded, failed, skipped',
    },
    {
      name: 'attempt',
      type: 'integer',
      defaultValue: 0,
    },
    {
      name: 'maxAttempts',
      type: 'integer',
      defaultValue: 2,
    },
    {
      name: 'dependsOn',
      type: 'json',
      defaultValue: [],
    },
    {
      name: 'dependencyPolicy',
      type: 'string',
      length: 30,
      defaultValue: 'require_success',
      comment: 'require_success or allow_skipped',
    },
    {
      name: 'approval',
      type: 'json',
      defaultValue: {},
    },
    {
      name: 'error',
      type: 'text',
    },
    {
      name: 'agentExecutionSpanId',
      type: 'bigInt',
    },
    {
      name: 'skillExecutionId',
      type: 'bigInt',
    },
    {
      name: 'metadata',
      type: 'json',
      defaultValue: {},
    },
    {
      name: 'startedAt',
      type: 'date',
    },
    {
      name: 'endedAt',
      type: 'date',
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
      fields: ['runId'],
    },
    {
      fields: ['status'],
    },
    {
      fields: ['planKey'],
    },
    {
      fields: ['runId', 'sequence'],
    },
    {
      fields: ['toolCallId'],
    },
    {
      fields: ['agentExecutionSpanId'],
    },
  ],
});
