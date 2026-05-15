import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'aiBrowserTasks',
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
      type: 'text',
      name: 'task',
    },
    {
      type: 'string',
      name: 'normalizedIntent',
    },
    {
      type: 'string',
      name: 'status',
      defaultValue: 'pending',
      // pending | running | completed | failed | cancelled
    },
    {
      type: 'json',
      name: 'result',
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
      type: 'belongsTo',
      name: 'triggeredBy',
      target: 'users',
      foreignKey: 'triggeredById',
    },
  ],
});
