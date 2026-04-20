import { CollectionOptions } from '@nocobase/database';

export default {
  name: 'embedAllowedPlugins',
  title: 'Embed Allowed Plugins',
  fields: [
    { name: 'id', type: 'bigInt', autoIncrement: true, primaryKey: true },
    { name: 'pluginName', type: 'string', length: 255, unique: true },
    { name: 'title', type: 'string', length: 255 },
    { name: 'enabled', type: 'boolean', defaultValue: true },
    { name: 'createdAt', type: 'date' },
    { name: 'updatedAt', type: 'date' },
  ],
} as CollectionOptions;
