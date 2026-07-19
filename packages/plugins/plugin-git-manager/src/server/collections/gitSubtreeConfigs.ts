import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'gitSubtreeConfigs',
  title: 'Git Subtree Configurations',
  autoGenId: true,
  createdAt: true,
  updatedAt: true,
  fields: [
    { type: 'string', name: 'name', allowNull: false },
    {
      type: 'belongsTo',
      name: 'repository',
      target: 'gitRepositories',
      foreignKey: 'repositoryId',
      onDelete: 'CASCADE',
    },
    { type: 'string', name: 'sourceBranch', allowNull: false },
    { type: 'string', name: 'sourcePrefix', allowNull: false },
    { type: 'json', name: 'sourcePrefixes' },
    { type: 'string', name: 'targetBranch', allowNull: false },
    { type: 'string', name: 'remoteName', allowNull: false, defaultValue: 'origin' },
    { type: 'string', name: 'defaultPolicy', allowNull: false, defaultValue: 'fastForward' },
    { type: 'boolean', name: 'pushAfterRun', allowNull: false, defaultValue: true },
    { type: 'boolean', name: 'enabled', allowNull: false, defaultValue: true },
    { type: 'date', name: 'lastRunAt' },
    { type: 'string', name: 'lastSplitSha' },
    { type: 'string', name: 'lastStatus' },
    { type: 'text', name: 'lastError' },
    {
      type: 'hasMany',
      name: 'runs',
      target: 'gitSubtreeRuns',
      foreignKey: 'configId',
      onDelete: 'CASCADE',
    },
  ],
});
