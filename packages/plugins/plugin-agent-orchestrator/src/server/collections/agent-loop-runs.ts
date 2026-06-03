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
      defaultValue: 'planning',
      comment:
        'planning, waiting_plan_approval, approved, running, waiting_user, needs_replan, succeeded, failed, rejected, canceled',
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
      comment: 'none, pending, approved, rejected, changes_requested',
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
      name: 'metadata',
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
      fields: ['leaderUsername'],
    },
    {
      fields: ['sessionId'],
    },
  ],
});
