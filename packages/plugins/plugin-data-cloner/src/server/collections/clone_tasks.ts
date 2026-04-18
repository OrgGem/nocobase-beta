import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'clone_tasks',
  fields: [
    { type: 'bigInt', name: 'id', primaryKey: true, autoIncrement: true },
    { type: 'string', name: 'source_datasource_key', required: true },
    { type: 'string', name: 'target_datasource_key', required: true },
    { 
      type: 'string', 
      name: 'status', 
      defaultValue: 'draft' 
      // enum: 'draft' | 'validating' | 'ready' | 'running' | 'completed' | 'failed' | 'paused'
    },
    { type: 'integer', name: 'total_tables', defaultValue: 0 },
    { type: 'integer', name: 'completed_tables', defaultValue: 0 },
  ],
});
