// SPDX-License-Identifier: Apache-2.0

import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'aiKnowledgeBaseDocuments',
  fields: [
    {
      type: 'uid',
      name: 'id',
      primaryKey: true,
    },
    {
      type: 'belongsTo',
      name: 'knowledgeBase',
      target: 'aiKnowledgeBases',
      foreignKey: 'knowledgeBaseId',
    },
    {
      type: 'belongsTo',
      name: 'file',
      target: 'aiFiles',
      foreignKey: 'fileId',
    },
    {
      type: 'string',
      name: 'filename',
      length: 512,
    },
    {
      // For pasted text content (no file upload)
      type: 'text',
      name: 'textContent',
    },
    {
      // pending | processing | success | failed
      type: 'string',
      name: 'status',
      defaultValue: 'pending',
    },
    {
      type: 'text',
      name: 'error',
    },
    {
      type: 'integer',
      name: 'chunkCount',
      defaultValue: 0,
    },
    {
      // User who uploaded this document
      type: 'bigInt',
      name: 'uploadedById',
    },
    {
      type: 'integer',
      name: 'retryCount',
      defaultValue: 0,
    },
    {
      type: 'json',
      name: 'meta',
    },
    // Index revisions are independent of the optional text-version history.
    { type: 'string', name: 'indexRevision' },
    { type: 'string', name: 'activeIndexRevision' },
    // Marks new documents until the first vectorization attempt; legacy NULL remains unknown.
    { type: 'string', name: 'indexWorkerToken' },
    { type: 'date', name: 'indexWorkerStartedAt' },
    { type: 'boolean', name: 'indexDeleted', defaultValue: false },
    { type: 'json', name: 'retiredIndexRevisions' },
    { type: 'boolean', name: 'indexCleanupNeeded', defaultValue: false },
    { type: 'integer', name: 'indexCleanupCursor', defaultValue: 0 },
    { type: 'date', name: 'indexCleanupAt' },
    { type: 'json', name: 'indexCleanupRoute' },
    { type: 'boolean', name: 'indexCleanupPending', defaultValue: false },
    { type: 'integer', name: 'indexCleanupProgress', defaultValue: 0 },
  ],
});
