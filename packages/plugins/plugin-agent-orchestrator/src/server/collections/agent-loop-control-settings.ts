import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'agentLoopControlSettings',
  title: 'Agent Loop Control Settings',
  fields: [
    { name: 'id', type: 'bigInt', autoIncrement: true, primaryKey: true },
    { name: 'key', type: 'string', length: 40, allowNull: false, unique: true, defaultValue: 'global' },
    { name: 'acceptNewRuns', type: 'boolean', defaultValue: true },
    { name: 'state', type: 'string', length: 20, defaultValue: 'running' },
    { name: 'reason', type: 'text' },
    { name: 'changedBy', type: 'belongsTo', target: 'users', foreignKey: 'changedById' },
    { name: 'changedAt', type: 'date' },
    { name: 'globalMaxConcurrency', type: 'integer', defaultValue: 5 },
    { name: 'dailyMaxTokens', type: 'integer' },
    { name: 'dailyMaxCost', type: 'float' },
    { name: 'createdAt', type: 'date' },
    { name: 'updatedAt', type: 'date' },
  ],
  indexes: [{ unique: true, fields: ['key'] }],
});
