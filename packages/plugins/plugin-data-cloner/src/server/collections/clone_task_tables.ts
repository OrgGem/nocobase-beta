import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'clone_task_tables',
  fields: [
    { type: 'bigInt', name: 'id', primaryKey: true, autoIncrement: true },
    { type: 'belongsTo', name: 'task', target: 'clone_tasks' },
    { type: 'string', name: 'table_name', required: true },
    { type: 'string', name: 'sort_column', required: true },
    { type: 'string', name: 'last_sync_value' },
    { 
      type: 'string', 
      name: 'status', 
      defaultValue: 'pending' 
      // enum: 'pending' | 'running' | 'completed' | 'error'
    },
    { type: 'integer', name: 'total_records', defaultValue: 0 },
    { type: 'integer', name: 'cloned_records', defaultValue: 0 },
    { type: 'text', name: 'error_message' },
  ],
});
