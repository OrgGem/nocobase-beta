import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'agentLoopWorktrees',
  title: 'Agent Loop Worktrees',
  fields: [
    { name: 'id', type: 'bigInt', autoIncrement: true, primaryKey: true },
    { name: 'runId', type: 'bigInt', allowNull: false },
    { name: 'run', type: 'belongsTo', target: 'agentLoopRuns', foreignKey: 'runId', allowNull: false },
    { name: 'repositoryKey', type: 'string', length: 200, allowNull: false },
    { name: 'repositoryRoot', type: 'string', length: 1000, allowNull: false },
    { name: 'baseRef', type: 'string', length: 200, allowNull: false },
    { name: 'branchName', type: 'string', length: 300, allowNull: false },
    { name: 'worktreePath', type: 'string', length: 1500, allowNull: false },
    { name: 'provider', type: 'string', length: 40, defaultValue: 'git' },
    { name: 'status', type: 'string', length: 30, defaultValue: 'creating' },
    { name: 'patchArtifactId', type: 'bigInt' },
    { name: 'cleanupReason', type: 'text' },
    { name: 'createdAt', type: 'date' },
    { name: 'activatedAt', type: 'date' },
    { name: 'removedAt', type: 'date' },
    { name: 'updatedAt', type: 'date' },
  ],
  indexes: [{ unique: true, fields: ['runId'] }, { fields: ['repositoryKey', 'status'] }, { fields: ['worktreePath'] }],
});
