import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'agentLoopCircuitStates',
  title: 'Agent Loop Circuit States',
  fields: [
    { name: 'id', type: 'bigInt', autoIncrement: true, primaryKey: true },
    { name: 'patternId', type: 'bigInt', allowNull: false },
    { name: 'pattern', type: 'belongsTo', target: 'agentLoopPatterns', foreignKey: 'patternId', allowNull: false },
    { name: 'scopeKey', type: 'string', length: 300, allowNull: false },
    { name: 'state', type: 'string', length: 20, defaultValue: 'closed' },
    { name: 'attempts', type: 'integer', defaultValue: 0 },
    { name: 'consecutiveFailures', type: 'integer', defaultValue: 0 },
    { name: 'errorSignature', type: 'string', length: 300 },
    { name: 'repeatedErrorCount', type: 'integer', defaultValue: 0 },
    { name: 'lastRunId', type: 'bigInt' },
    { name: 'openedAt', type: 'date' },
    { name: 'retryAt', type: 'date' },
    { name: 'createdAt', type: 'date' },
    { name: 'updatedAt', type: 'date' },
  ],
  indexes: [{ unique: true, fields: ['patternId', 'scopeKey'] }, { fields: ['state', 'retryAt'] }],
});
