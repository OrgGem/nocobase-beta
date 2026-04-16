import { CollectionOptions } from '@nocobase/database';

export default {
  name: 'doc_understanding_pipeline_steps',
  title: 'Pipeline Steps',
  fields: [
    {
      type: 'belongsTo',
      name: 'pipeline',
      target: 'doc_understanding_pipelines',
      foreignKey: 'pipelineId',
    },
    {
      type: 'belongsTo',
      name: 'endpoint',
      target: 'doc_understanding_endpoints',
      foreignKey: 'endpointId',
    },
    { type: 'integer', name: 'stepOrder' },
    { type: 'string', name: 'name', length: 100 },
    { type: 'json', name: 'inputMapping' },
    { type: 'string', name: 'outputAlias', length: 100 },
    { type: 'json', name: 'condition' },
    { type: 'string', name: 'onError', length: 20, defaultValue: 'fail' },
    { type: 'integer', name: 'retryCount', defaultValue: 0 },
  ],
} as CollectionOptions;
