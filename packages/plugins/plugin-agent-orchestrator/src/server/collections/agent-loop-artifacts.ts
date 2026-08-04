import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'agentLoopArtifacts',
  title: 'Agent Loop Artifacts',
  fields: [
    { name: 'id', type: 'bigInt', autoIncrement: true, primaryKey: true },
    { name: 'runId', type: 'bigInt', allowNull: false },
    { name: 'run', type: 'belongsTo', target: 'agentLoopRuns', foreignKey: 'runId', allowNull: false },
    { name: 'stepId', type: 'bigInt' },
    { name: 'step', type: 'belongsTo', target: 'agentLoopSteps', foreignKey: 'stepId' },
    { name: 'span', type: 'belongsTo', target: 'agentExecutionSpans', foreignKey: 'spanId' },
    { name: 'kind', type: 'string', length: 40, allowNull: false },
    { name: 'title', type: 'string', length: 500 },
    { name: 'uri', type: 'string', length: 2000 },
    { name: 'contentHash', type: 'string', length: 128 },
    { name: 'sizeBytes', type: 'bigInt', defaultValue: 0 },
    { name: 'producerRole', type: 'string', length: 30 },
    { name: 'producerUsername', type: 'string', length: 100 },
    { name: 'metadata', type: 'json', defaultValue: {} },
    { name: 'createdAt', type: 'date' },
    { name: 'updatedAt', type: 'date' },
  ],
  indexes: [{ fields: ['runId', 'kind'] }, { fields: ['contentHash'] }, { fields: ['stepId'] }],
});
