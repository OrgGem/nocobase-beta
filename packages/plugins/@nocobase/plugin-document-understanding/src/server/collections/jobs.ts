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
    {
      type: 'belongsTo',
      name: 'createdBy',
      target: 'users',
      foreignKey: 'createdById',
    },
  ],
} as CollectionOptions;
