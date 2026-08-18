import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'agentLoopRuns',
  title: 'Agent Loop Runs',
  fields: [
    {
      name: 'id',
      type: 'bigInt',
      autoIncrement: true,
      primaryKey: true,
    },
    {
      name: 'rootRunId',
      type: 'string',
      length: 100,
      allowNull: false,
    },
    {
      name: 'runtimeVersion',
      type: 'string',
      length: 40,
      defaultValue: 'control-plane-v2',
    },
    {
      name: 'recordMode',
      type: 'string',
      length: 30,
      defaultValue: 'observed-execution',
    },
    {
      name: 'patternId',
      type: 'bigInt',
    },
    {
      name: 'pattern',
      type: 'belongsTo',
      target: 'agentLoopPatterns',
      foreignKey: 'patternId',
    },
    {
      name: 'triggerType',
      type: 'string',
      length: 20,
    },
    {
      name: 'triggerKey',
      type: 'string',
      length: 300,
    },
    {
      name: 'triggerPayload',
      type: 'json',
      defaultValue: {},
    },
    {
      name: 'autonomyLevel',
      type: 'string',
      length: 10,
      defaultValue: 'L1',
    },
    {
      name: 'roleBindingsSnapshot',
      type: 'json',
      defaultValue: {},
    },
    {
      name: 'leaderHarnessSnapshot',
      type: 'json',
      defaultValue: {},
    },
    {
      name: 'makerHarnessSnapshot',
      type: 'json',
      defaultValue: {},
    },
    {
      name: 'verifierHarnessSnapshot',
      type: 'json',
      defaultValue: {},
    },
    {
      name: 'policySnapshot',
      type: 'json',
      defaultValue: {},
    },
    {
      name: 'sessionId',
      type: 'string',
      length: 100,
    },
    {
      name: 'messageId',
      type: 'string',
      length: 100,
    },
    {
      name: 'leaderUsername',
      type: 'string',
      length: 100,
    },
    {
      name: 'goal',
      type: 'text',
    },
    {
      name: 'status',
      type: 'string',
      length: 30,
      defaultValue: 'queued',
      comment:
        'queued, preparing, waiting_lock, running, waiting_approval, verifying, waiting_human, paused, blocked, succeeded, failed, canceled',
    },
    {
      name: 'currentStepId',
      type: 'bigInt',
    },
    {
      name: 'policy',
      type: 'json',
      defaultValue: {},
    },
    {
      name: 'iterationCount',
      type: 'integer',
      defaultValue: 0,
    },
    {
      name: 'approvalStatus',
      type: 'string',
      length: 30,
      defaultValue: 'none',
      comment: 'none, pending, decided, expired, approved, rejected, changes_requested',
    },
    {
      name: 'resumeContext',
      type: 'json',
      allowNull: true,
      comment: 'Where an interrupted run must continue: role, username, session, message, reports so far.',
    },
    {
      name: 'approvedBy',
      type: 'belongsTo',
      target: 'users',
      foreignKey: 'approvedById',
    },
    {
      name: 'approvedAt',
      type: 'date',
    },
    {
      name: 'rejectionReason',
      type: 'text',
    },
    {
      name: 'changeRequest',
      type: 'text',
    },
    {
      name: 'planVersion',
      type: 'integer',
      defaultValue: 1,
    },
    {
      name: 'planSource',
      type: 'string',
      length: 50,
    },
    {
      name: 'plannerModel',
      type: 'string',
      length: 100,
    },
    {
      name: 'lockedBy',
      type: 'string',
      length: 100,
    },
    {
      name: 'lockedUntil',
      type: 'date',
    },
    {
      name: 'finalAnswer',
      type: 'text',
    },
    {
      name: 'summary',
      type: 'text',
    },
    {
      name: 'totalInputTokens',
      type: 'integer',
      defaultValue: 0,
      comment: 'Accumulated input/prompt tokens across all spans in this run',
    },
    {
      name: 'totalOutputTokens',
      type: 'integer',
      defaultValue: 0,
      comment: 'Accumulated output/completion tokens across all spans in this run',
    },
    {
      name: 'totalTokens',
      type: 'integer',
      defaultValue: 0,
      comment: 'Total accumulated tokens (input + output) across all spans in this run',
    },
    {
      name: 'totalCost',
      type: 'float',
      defaultValue: 0,
      comment: 'Estimated total cost in USD across all spans in this run',
    },
    {
      name: 'budgetMaxTokens',
      type: 'integer',
      allowNull: true,
      comment: 'Maximum allowed tokens for this run (null = unlimited)',
    },
    {
      name: 'budgetMaxCost',
      type: 'float',
      allowNull: true,
      comment: 'Maximum allowed cost in USD for this run (null = unlimited)',
    },
    {
      name: 'repositoryKey',
      type: 'string',
      length: 200,
    },
    {
      name: 'repositoryRoot',
      type: 'string',
      length: 1000,
    },
    {
      name: 'baseRef',
      type: 'string',
      length: 200,
    },
    {
      name: 'actingOn',
      type: 'json',
      defaultValue: [],
    },
    {
      name: 'worktreeId',
      type: 'bigInt',
    },
    {
      name: 'currentRole',
      type: 'string',
      length: 30,
    },
    {
      name: 'invocationCount',
      type: 'integer',
      defaultValue: 0,
    },
    {
      name: 'toolCallCount',
      type: 'integer',
      defaultValue: 0,
    },
    {
      name: 'delegationCount',
      type: 'integer',
      defaultValue: 0,
    },
    {
      name: 'verificationCount',
      type: 'integer',
      defaultValue: 0,
    },
    {
      name: 'blockedReason',
      type: 'text',
    },
    {
      name: 'escalationReason',
      type: 'text',
    },
    {
      name: 'verifierUsername',
      type: 'string',
      length: 100,
    },
    {
      name: 'verifierVerdict',
      type: 'string',
      length: 20,
    },
    {
      name: 'verifierEvidence',
      type: 'json',
      defaultValue: {},
    },
    {
      name: 'metadata',
      type: 'json',
      defaultValue: {},
    },
    {
      name: 'userId',
      type: 'bigInt',
    },
    {
      name: 'user',
      type: 'belongsTo',
      target: 'users',
      foreignKey: 'userId',
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
      fields: ['rootRunId'],
    },
    {
      fields: ['status'],
    },
    {
      // Covers the worker claim hot path: filter by status, order by creation.
      fields: ['status', 'createdAt'],
    },
    {
      fields: ['leaderUsername'],
    },
    {
      fields: ['sessionId'],
    },
    {
      fields: ['patternId', 'status'],
    },
    {
      unique: true,
      fields: ['patternId', 'triggerKey'],
    },
    {
      fields: ['userId', 'status'],
    },
    {
      fields: ['lockedUntil'],
    },
  ],
});
