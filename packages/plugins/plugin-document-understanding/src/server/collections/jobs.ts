import { CollectionOptions } from '@nocobase/database';

export default {
  name: 'doc_understanding_jobs',
  title: 'Document Pipeline Jobs',
  fields: [
    {
      type: 'belongsTo',
      name: 'pipeline',
      target: 'doc_understanding_pipelines',
      foreignKey: 'pipelineId',
    },
    { type: 'string', name: 'status', length: 20, defaultValue: 'pending' },
    { type: 'json', name: 'input' },
    { type: 'integer', name: 'currentStep' },
    { type: 'json', name: 'stepResults' },
    { type: 'json', name: 'finalResult' },
    { type: 'text', name: 'error' },
    { type: 'json', name: 'externalTaskIds' },
    { type: 'date', name: 'startedAt' },
    { type: 'date', name: 'completedAt' },
    // Cluster ownership: which node is executing/polling this job, and until when
    // its lease is valid. Orphaned jobs (owner restarted or lease expired) are
    // failed or re-adopted by the maintenance sweep.
    { type: 'string', name: 'ownedBy', length: 255 },
    { type: 'date', name: 'leaseExpiresAt' },
    {
      type: 'belongsTo',
      name: 'createdBy',
      target: 'users',
      foreignKey: 'createdById',
    },
  ],
  indexes: [
    {
      fields: ['status'],
    },
    {
      fields: ['leaseExpiresAt'],
    },
  ],
} as CollectionOptions;
