import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'fileSearchDocuments',
  title: 'File search documents',
  filterTargetKey: 'id',
  fields: [
    { type: 'string', name: 'fileCollection', index: true },
    { type: 'string', name: 'fileId', index: true },
    { type: 'string', name: 'filename' },
    { type: 'string', name: 'mimetype' },
    { type: 'string', name: 'extname', index: true },
    { type: 'bigInt', name: 'size' },
    { type: 'string', name: 'checksum' },
    { type: 'string', name: 'status', defaultValue: 'pending', index: true },
    { type: 'string', name: 'pageIndexDocId', index: true },
    { type: 'date', name: 'indexedAt' },
    { type: 'text', name: 'errorMessage' },
    { type: 'bigInt', name: 'createdById', index: true },
  ],
});
