import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'aiBuildUiTemplateSpaces',
  shared: true,
  dumpRules: 'required',
  migrationRules: ['overwrite', 'schema-only'],
  timestamps: true,
  fields: [
    {
      type: 'uid',
      name: 'id',
      primaryKey: true,
    },
    {
      type: 'string',
      name: 'title',
    },
    {
      type: 'string',
      name: 'llmService',
    },
    {
      type: 'string',
      name: 'model',
    },
    {
      type: 'text',
      name: 'systemPrompt',
    },
    {
      type: 'text',
      name: 'promptRequirements',
    },
    {
      type: 'string',
      name: 'type',
      defaultValue: 'block', // 'block' or 'popup'
    },
    {
      type: 'string',
      name: 'targetCollection',
    },
    {
      type: 'string',
      name: 'buildPhase',
      defaultValue: 'idle',
    },
    {
      type: 'string',
      name: 'buildRunId',
    },
    {
      type: 'date',
      name: 'buildQueuedAt',
    },
    {
      type: 'date',
      name: 'buildStartedAt',
    },
    {
      type: 'date',
      name: 'buildHeartbeatAt',
    },
    {
      type: 'string',
      name: 'buildWorkerId',
    },
    {
      type: 'string',
      name: 'templateUid',
    },
    {
      type: 'string',
      name: 'status',
      defaultValue: 'draft',
    },
    {
      type: 'text',
      name: 'buildLog',
    },
  ],
});
