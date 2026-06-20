import { defineCollection } from '@nocobase/database';

/**
 * Stores delegation execution logs for Swarm Tracing (Phase 5).
 *
 * Legacy delegation events were logged to a dedicated table for observability.
 * Native plugin-ai runs are now observed through agentExecutionSpans.
 */
export default defineCollection({
  name: 'orchestratorLogs',
  title: 'Orchestrator Logs',
  fields: [
    {
      name: 'id',
      type: 'bigInt',
      autoIncrement: true,
      primaryKey: true,
    },
    {
      name: 'leaderUsername',
      type: 'string',
      allowNull: false,
      comment: 'The AI Employee that initiated the delegation',
    },
    {
      name: 'subAgentUsername',
      type: 'string',
      allowNull: false,
      comment: 'The AI Employee that executed the delegated task',
    },
    {
      name: 'toolName',
      type: 'string',
      comment: 'Legacy delegation or native dispatch tool name',
    },
    {
      name: 'context',
      type: 'text',
      comment: 'Optional context sent with the delegated task',
    },
    {
      name: 'task',
      type: 'text',
      comment: 'The task description sent to the sub-agent',
    },
    {
      name: 'result',
      type: 'text',
      comment: 'The sub-agent result content',
    },
    {
      name: 'status',
      type: 'string',
      comment: 'running, success, or error',
    },
    {
      name: 'depth',
      type: 'integer',
      defaultValue: 0,
      comment: 'Delegation depth level (0 = first-level delegation)',
    },
    {
      name: 'durationMs',
      type: 'integer',
      comment: 'Execution duration in milliseconds',
    },
    {
      name: 'error',
      type: 'text',
      comment: 'Error message if status is error',
    },
    {
      name: 'trace',
      type: 'json',
      defaultValue: [],
      comment: 'Structured timeline of sub-agent execution and tool calls',
    },
    {
      name: 'messages',
      type: 'json',
      defaultValue: [],
      comment: 'Serialized message snapshots from the sub-agent run',
    },
    {
      name: 'userId',
      type: 'bigInt',
      comment: 'The user who triggered the leader conversation',
    },
    {
      name: 'createdAt',
      type: 'date',
      interface: 'createdAt',
      field: 'createdAt',
      uiSchema: {
        type: 'datetime',
        title: '{{t("Created at")}}',
        'x-component': 'DatePicker',
        'x-component-props': { showTime: true },
        'x-read-pretty': true,
      },
    },
    {
      name: 'updatedAt',
      type: 'date',
      interface: 'updatedAt',
      field: 'updatedAt',
      uiSchema: {
        type: 'datetime',
        title: '{{t("Updated at")}}',
        'x-component': 'DatePicker',
        'x-component-props': { showTime: true },
        'x-read-pretty': true,
      },
    },
  ],
});
