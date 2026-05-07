import { CollectionOptions } from '@nocobase/database';

export default {
  name: 'uipathFoldersCache',
  title: 'UiPath Folders Cache',
  fields: [
    { name: 'id', type: 'bigInt', autoIncrement: true, primaryKey: true },
    { name: 'instanceId', type: 'bigInt' },
    { name: 'instance', type: 'belongsTo', target: 'uipathInstances', foreignKey: 'instanceId' },
    { name: 'folderId', type: 'bigInt' },
    { name: 'folderKey', type: 'string', length: 100 },
    { name: 'displayName', type: 'string', length: 300 },
    { name: 'fullyQualifiedName', type: 'string', length: 500 },
    { name: 'parentId', type: 'bigInt' },
    { name: 'isPersonal', type: 'boolean', defaultValue: false },
    { name: 'lastSyncedAt', type: 'date' },
    { name: 'createdAt', type: 'date' },
    { name: 'updatedAt', type: 'date' },
  ],
} as CollectionOptions;
