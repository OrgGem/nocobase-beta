/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

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
      type: 'json',
      name: 'meta',
    },
  ],
});
