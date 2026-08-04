import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'agentLoopUsageBuckets',
  title: 'Agent Loop Usage Buckets',
  fields: [
    { name: 'id', type: 'bigInt', autoIncrement: true, primaryKey: true },
    { name: 'patternId', type: 'bigInt', allowNull: false },
    { name: 'pattern', type: 'belongsTo', target: 'agentLoopPatterns', foreignKey: 'patternId', allowNull: false },
    { name: 'bucketDate', type: 'dateOnly', allowNull: false },
    { name: 'invocationCount', type: 'integer', defaultValue: 0 },
    { name: 'toolCallCount', type: 'integer', defaultValue: 0 },
    { name: 'delegationCount', type: 'integer', defaultValue: 0 },
    { name: 'inputTokens', type: 'integer', defaultValue: 0 },
    { name: 'outputTokens', type: 'integer', defaultValue: 0 },
    { name: 'totalTokens', type: 'integer', defaultValue: 0 },
    { name: 'totalCost', type: 'float', defaultValue: 0 },
    { name: 'createdAt', type: 'date' },
    { name: 'updatedAt', type: 'date' },
  ],
  indexes: [{ unique: true, fields: ['patternId', 'bucketDate'] }, { fields: ['bucketDate'] }],
});
