import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'aiBrowserSessions',
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
      name: 'status',
      defaultValue: 'pending',
      // pending | running | completed | failed | stopped | expired
    },
    {
      type: 'string',
      name: 'mode',
      defaultValue: 'readonly',
    },
    {
      type: 'string',
      name: 'driver',
      defaultValue: 'playwright-browserless',
    },
    {
      type: 'string',
      name: 'externalSessionId',
    },
    {
      type: 'text',
      name: 'liveUrl',
    },
    {
      type: 'text',
      name: 'currentUrl',
    },
    {
      type: 'boolean',
      name: 'liveViewOpened',
      defaultValue: false,
    },
    {
      type: 'belongsTo',
      name: 'profile',
      target: 'aiBrowserProfiles',
      foreignKey: 'profileId',
    },
    {
      type: 'belongsTo',
      name: 'owner',
      target: 'users',
      foreignKey: 'ownerId',
    },
    {
      type: 'string',
      name: 'conversationId',
    },
    {
      type: 'date',
      name: 'startedAt',
    },
    {
      type: 'date',
      name: 'endedAt',
    },
    {
      type: 'date',
      name: 'expiresAt',
    },
    {
      type: 'json',
      name: 'metadata',
    },
    {
      type: 'hasMany',
      name: 'tasks',
      target: 'aiBrowserTasks',
      foreignKey: 'sessionId',
    },
    {
      type: 'hasMany',
      name: 'actionEvents',
      target: 'aiBrowserActionEvents',
      foreignKey: 'sessionId',
    },
  ],
});
