import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'orchestratorConfig',
  title: 'Orchestrator Config',
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
      comment: 'AI Employee username that acts as the Leader/Orchestrator',
    },
    {
      name: 'subAgentUsername',
      type: 'string',
      allowNull: false,
      comment: 'AI Employee username that acts as the Sub-Agent',
    },
    {
      name: 'enabled',
      type: 'boolean',
      defaultValue: true,
    },
    {
      name: 'maxDepth',
      type: 'integer',
      defaultValue: 1,
      comment: 'Maximum delegation depth (1 = leader can call sub, sub cannot call further)',
    },
    {
      name: 'timeout',
      type: 'integer',
      defaultValue: 120000,
      comment: 'Timeout in ms for sub-agent execution',
    },
    {
      name: 'recursionLimit',
      type: 'integer',
      defaultValue: 50,
      comment:
        'Max LangGraph reasoning steps (tool-call + LLM-step iterations) per delegation. Lower = safer; higher = more complex multi-step tasks. Default 50.',
    },
    {
      name: 'harnessTag',
      type: 'string',
      length: 100,
      defaultValue: 'default',
      comment: 'Harness profile tag used by the orchestrator controller and approval flow.',
    },
    {
      name: 'llmService',
      type: 'string',
      comment: 'Optional overridden LLM provider for the sub-agent',
    },
    {
      name: 'model',
      type: 'string',
      comment: 'Optional overridden model for the sub-agent',
    },
  ],
  indexes: [
    {
      unique: true,
      fields: ['leaderUsername', 'subAgentUsername'],
    },
  ],
});
