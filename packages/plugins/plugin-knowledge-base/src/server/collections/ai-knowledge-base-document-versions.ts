// SPDX-License-Identifier: Apache-2.0

import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'aiKnowledgeBaseDocumentVersions',
  title: 'Knowledge Base Document Versions',
  fields: [
    {
      type: 'bigInt',
      name: 'id',
      autoIncrement: true,
      primaryKey: true,
    },
    {
      type: 'uid',
      name: 'documentId',
    },
    {
      type: 'integer',
      name: 'version',
      defaultValue: 1,
    },
    {
      type: 'text',
      name: 'textContent',
    },
    {
      type: 'string',
      name: 'filename',
      length: 512,
    },
    {
      // How this version was created
      // initial | update | reprocess | restore
      type: 'string',
      name: 'changeType',
      length: 20,
      defaultValue: 'initial',
    },
    {
      type: 'json',
      name: 'metadata',
    },
    {
      type: 'bigInt',
      name: 'createdBy',
    },
    {
      type: 'date',
      name: 'createdAt',
    },
  ],
  indexes: [{ fields: ['documentId', 'version'] }],
});
