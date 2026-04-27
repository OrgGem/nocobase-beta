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
  ],
  indexes: [
    {
      unique: true,
      fields: ['leaderUsername', 'subAgentUsername'],
    },
  ],
});
