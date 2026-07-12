import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'fileSearchReferences',
  title: 'File search references',
  filterTargetKey: 'id',
  fields: [
    {
      type: 'belongsTo',
      name: 'document',
      target: 'fileSearchDocuments',
      foreignKey: 'documentId',
      onDelete: 'CASCADE',
    },
    { type: 'bigInt', name: 'documentId', index: true },
    { type: 'string', name: 'ownerCollection', index: true },
    { type: 'string', name: 'ownerRecordId', index: true },
    { type: 'string', name: 'ownerField' },
    { type: 'string', name: 'fileCollection', index: true },
    { type: 'string', name: 'fileId', index: true },
    { type: 'string', name: 'relationType', defaultValue: 'standalone' },
  ],
});
