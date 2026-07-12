import { CollectionOptions } from '@nocobase/database';

export default {
  name: 'uipathMonitorProcesses',
  title: 'UiPath Monitor Processes',
  fields: [
    { name: 'id', type: 'bigInt', autoIncrement: true, primaryKey: true },
    { name: 'instanceId', type: 'bigInt', index: true },
    { name: 'instance', type: 'belongsTo', target: 'uipathInstances', foreignKey: 'instanceId' },
    { name: 'code', type: 'string', length: 100, index: true },
    { name: 'name', type: 'string', length: 200 },
    { name: 'description', type: 'text' },
    { name: 'owner', type: 'string', length: 200 },
    { name: 'enabled', type: 'boolean', defaultValue: true, index: true },
    { name: 'tags', type: 'json' },
    { name: 'defaultWindowMinutes', type: 'integer', defaultValue: 1440 },
    { name: 'createdAt', type: 'date' },
    { name: 'updatedAt', type: 'date' },
  ],
} as CollectionOptions;
