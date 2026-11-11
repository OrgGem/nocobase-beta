/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { defineCollection } from '@nocobase/database';

/**
 * Unified execution graph for agent orchestration.
 *
 * A root run can contain sub-agent spans and child tool/skill spans. Skill Hub
 * keeps its own sandbox execution records; this collection stores the flow
 * relationship and links to those records when applicable.
 */
export default defineCollection({
  name: 'agentExecutionSpans',
  title: 'Agent Execution Spans',
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
      name: 'agentLoopRunId',
      type: 'bigInt',
    },
    {
      name: 'agentLoopStepId',
      type: 'bigInt',
    },
    {
      name: 'patternId',
      type: 'bigInt',
    },
    {
      name: 'role',
      type: 'string',
      length: 30,
    },
    {
      name: 'harnessProfileTag',
      type: 'string',
      length: 100,
    },
    {
      name: 'harnessProfileVersion',
      type: 'integer',
    },
    {
      name: 'policyDecision',
      type: 'json',
      defaultValue: {},
    },
    {
      name: 'approvalId',
      type: 'bigInt',
    },
    {
      name: 'parentSpanId',
      type: 'string',
      length: 100,
    },
    {
      // Delegation depth of a sub-agent span: 1 for a sub-agent dispatched from a top-level
      // conversation, parent depth + 1 below that. Persisted so a resumed child can never reset
      // its depth, and the harness delegation.maxDepth cap is enforceable across restarts.
      name: 'depth',
      type: 'integer',
      defaultValue: 0,
    },
    {
      name: 'source',
      type: 'string',
      length: 100,
      comment: 'native-plugin-ai or legacy orchestrator source.',
    },
    {
      name: 'nativeIdentity',
      type: 'string',
      length: 512,
      allowNull: true,
      comment: 'Stable identity of a native agent, tool, or dispatch projection.',
    },
    {
      name: 'nativeActivityAt',
      type: 'date',
      allowNull: true,
      comment: 'Source activity timestamp used for native projection retention.',
    },
    {
      name: 'usageIdentity',
      type: 'string',
      length: 512,
      allowNull: true,
      comment: 'Stable identity for one model-call usage record.',
    },
    {
      name: 'usageSessionId',
      type: 'uuid',
      allowNull: true,
      comment: 'Native AI conversation session associated with a usage record.',
    },
    {
      name: 'usageMessageId',
      type: 'string',
      length: 200,
      allowNull: true,
      comment: 'Native AI message identity associated with a usage record.',
    },
    {
      name: 'usageOccurredAt',
      type: 'date',
      allowNull: true,
      comment: 'Source timestamp of the native model-call usage event.',
    },
    {
      name: 'model',
      type: 'string',
      length: 255,
    },
    {
      name: 'provider',
      type: 'string',
      length: 100,
    },
    {
      name: 'llmService',
      type: 'string',
      length: 100,
    },
    {
      name: 'usageSource',
      type: 'string',
      length: 20,
      comment: 'actual, estimated, or missing usage.',
    },
    {
      name: 'usageOrigin',
      type: 'string',
      length: 40,
      comment: 'Native usage event, loop runtime, estimate, or invocation summary.',
    },
    {
      name: 'pricingStatus',
      type: 'string',
      length: 20,
      comment: 'configured, estimated, native, or unpriced.',
    },
    {
      name: 'priceSource',
      type: 'string',
      length: 40,
    },
    {
      name: 'priceCurrency',
      type: 'string',
      length: 3,
    },
    {
      name: 'priceVersion',
      type: 'string',
      length: 100,
    },
    {
      name: 'priceInputPer1k',
      type: 'float',
    },
    {
      name: 'priceOutputPer1k',
      type: 'float',
    },
    {
      name: 'priceCachedInputPer1k',
      type: 'float',
    },
    {
      name: 'parentSessionId',
      type: 'uuid',
      comment: 'Main AI conversation session id when this span comes from native plugin-ai.',
    },
    {
      name: 'subSessionId',
      type: 'uuid',
      comment: 'Sub-agent AI conversation session id when this span comes from native plugin-ai.',
    },
    {
      name: 'toolCallId',
      type: 'string',
      length: 200,
      comment: 'Native AI tool call id associated with this span.',
    },
    {
      name: 'type',
      type: 'string',
      length: 30,
      comment: 'sub_agent, tool, skill, dispatch, model_call, invocation_summary',
    },
    {
      name: 'status',
      type: 'string',
      length: 20,
      comment: 'running, success, error, canceled, timeout',
    },
    {
      name: 'leaderUsername',
      type: 'string',
      length: 100,
    },
    {
      name: 'employeeUsername',
      type: 'string',
      length: 100,
      comment: 'The AI Employee currently executing this span',
    },
    {
      name: 'toolName',
      type: 'string',
      length: 200,
    },
    {
      name: 'title',
      type: 'string',
      length: 500,
    },
    {
      name: 'input',
      type: 'json',
      defaultValue: {},
    },
    {
      name: 'output',
      type: 'text',
    },
    {
      name: 'error',
      type: 'text',
    },
    {
      name: 'durationMs',
      type: 'integer',
    },
    {
      name: 'inputTokens',
      type: 'integer',
      allowNull: true,
      comment: 'Number of input/prompt tokens consumed by this span',
    },
    {
      name: 'outputTokens',
      type: 'integer',
      allowNull: true,
      comment: 'Number of output/completion tokens generated by this span',
    },
    {
      name: 'totalTokens',
      type: 'integer',
      allowNull: true,
      comment: 'Total tokens consumed by this span (input + output)',
    },
    {
      name: 'cost',
      type: 'float',
      allowNull: true,
      comment: 'Computed cost from an explicit price snapshot; null means unpriced.',
    },
    {
      name: 'cachedTokens',
      type: 'integer',
      allowNull: true,
    },
    {
      name: 'reasoningTokens',
      type: 'integer',
      allowNull: true,
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
      name: 'orchestratorLogId',
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
      name: 'userId',
      type: 'bigInt',
    },
    {
      name: 'departmentId',
      type: 'bigInt',
      allowNull: true,
      comment: 'Department recorded from a trusted invocation snapshot.',
    },
    {
      name: 'departmentAttribution',
      type: 'string',
      length: 20,
      allowNull: true,
      comment: 'How the department was attributed. Null means unknown.',
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
      fields: ['parentSpanId'],
    },
    {
      fields: ['source'],
    },
    {
      fields: ['nativeIdentity'],
      unique: true,
    },
    {
      fields: ['nativeActivityAt'],
    },
    {
      fields: ['usageIdentity'],
      unique: true,
    },
    {
      fields: ['usageSessionId', 'usageMessageId'],
    },
    {
      fields: ['parentSessionId'],
    },
    {
      fields: ['subSessionId'],
    },
    {
      fields: ['toolCallId'],
    },
    {
      fields: ['type'],
    },
    {
      fields: ['status'],
    },
    {
      fields: ['userId'],
    },
    {
      fields: ['departmentId'],
    },
    {
      fields: ['agentLoopRunId'],
    },
    {
      fields: ['agentLoopStepId'],
    },
    {
      fields: ['patternId'],
    },
    {
      fields: ['approvalId'],
    },
  ],
});
