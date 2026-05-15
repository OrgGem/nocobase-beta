import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'aiBrowserActionEvents',
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
      type: 'belongsTo',
      name: 'session',
      target: 'aiBrowserSessions',
      foreignKey: 'sessionId',
    },
    {
      type: 'belongsTo',
      name: 'task',
      target: 'aiBrowserTasks',
      foreignKey: 'taskId',
    },
    {
      type: 'string',
      name: 'eventType',
      // navigate | click | type | select | wait | extract | screenshot | download | error | policy_block
    },
    {
      type: 'text',
      name: 'description',
    },
    {
      type: 'text',
      name: 'url',
    },
    {
      type: 'string',
      name: 'selector',
    },
    {
      type: 'text',
      name: 'inputValue',
    },
    {
      type: 'json',
      name: 'result',
    },
    {
      type: 'text',
      name: 'screenshotPath',
    },
    {
      type: 'text',
      name: 'error',
    },
    {
      type: 'integer',
      name: 'durationMs',
    },
    {
      type: 'integer',
      name: 'stepIndex',
    },
    {
      type: 'json',
      name: 'metadata',
    },
  ],
});
