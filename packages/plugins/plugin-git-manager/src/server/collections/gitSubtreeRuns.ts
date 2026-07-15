import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'gitSubtreeRuns',
  title: 'Git Subtree Runs',
  autoGenId: true,
  createdAt: true,
  updatedAt: true,
  fields: [
    {
      type: 'belongsTo',
      name: 'config',
      target: 'gitSubtreeConfigs',
      foreignKey: 'configId',
      onDelete: 'CASCADE',
    },
    { type: 'string', name: 'policy', allowNull: false },
    { type: 'string', name: 'executionMode', allowNull: false, defaultValue: 'app' },
    { type: 'string', name: 'sourceSha' },
    { type: 'string', name: 'splitSha' },
    { type: 'string', name: 'targetBeforeSha' },
    { type: 'string', name: 'targetAfterSha' },
    { type: 'string', name: 'status', allowNull: false, defaultValue: 'running' },
    { type: 'date', name: 'startedAt', allowNull: false },
    { type: 'date', name: 'finishedAt' },
    { type: 'text', name: 'output' },
    { type: 'text', name: 'error' },
    { type: 'bigInt', name: 'triggeredById' },
  ],
});
