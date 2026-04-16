import { CollectionOptions } from '@nocobase/database';

export default {
  name: 'doc_understanding_pipelines',
  title: 'Document Pipelines',
  fields: [
    { type: 'string', name: 'name', unique: true, length: 200 },
    { type: 'text', name: 'description' },
    { type: 'json', name: 'inputSchema' },
    { type: 'json', name: 'outputMapping' },
    { type: 'boolean', name: 'enabled', defaultValue: true },
    {
      type: 'hasMany',
      name: 'steps',
      target: 'doc_understanding_pipeline_steps',
      foreignKey: 'pipelineId',
    },
  ],
} as CollectionOptions;
