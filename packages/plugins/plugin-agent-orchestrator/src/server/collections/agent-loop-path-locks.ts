import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'agentLoopPathLocks',
  title: 'Agent Loop Path Locks',
  fields: [
    { name: 'id', type: 'bigInt', autoIncrement: true, primaryKey: true },
    { name: 'runId', type: 'bigInt', allowNull: false },
    { name: 'run', type: 'belongsTo', target: 'agentLoopRuns', foreignKey: 'runId', allowNull: false },
    { name: 'repositoryKey', type: 'string', length: 200, allowNull: false },
    { name: 'owner', type: 'string', length: 200, allowNull: false },
    { name: 'paths', type: 'json', defaultValue: [] },
    { name: 'status', type: 'string', length: 20, defaultValue: 'waiting' },
    { name: 'blockerRunIds', type: 'json', defaultValue: [] },
    { name: 'acquiredAt', type: 'date' },
    { name: 'expiresAt', type: 'date' },
    { name: 'waitUntil', type: 'date' },
    { name: 'releasedAt', type: 'date' },
    { name: 'createdAt', type: 'date' },
    { name: 'updatedAt', type: 'date' },
  ],
  indexes: [
    { fields: ['repositoryKey', 'status'] },
    { unique: true, fields: ['runId', 'repositoryKey'] },
    { fields: ['expiresAt'] },
  ],
});
