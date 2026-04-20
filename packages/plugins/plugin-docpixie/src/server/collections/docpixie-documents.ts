/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * DocPixie Documents — Collection Definition
 *
 * Stores indexed documents with their processing status and summaries.
 * Relation: docpixie_documents (1) → (N) docpixie_pages
 */
import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'docpixie_documents',
  title: 'DocPixie Documents',
  fields: [
    { type: 'bigInt', name: 'id', primaryKey: true, autoIncrement: true },
    { type: 'string', name: 'name', length: 500 },
    { type: 'string', name: 'originalPath', length: 1000 },
    { type: 'string', name: 'storagePath', length: 1000 },
    { type: 'string', name: 'fileType', length: 20, defaultValue: 'pdf' },
    { type: 'integer', name: 'pageCount', defaultValue: 0 },
    { type: 'text', name: 'summary' },
    {
      type: 'string',
      name: 'status',
      length: 20,
      defaultValue: 'pending',
    },
    {
      type: 'string',
      name: 'extractionMethod',
      length: 20,
      defaultValue: 'external_api',
    },
    { type: 'json', name: 'metadata', defaultValue: {} },
    { type: 'date', name: 'createdAt' },
    { type: 'date', name: 'updatedAt' },
    {
      type: 'hasMany',
      name: 'pages',
      target: 'docpixie_pages',
      foreignKey: 'documentId',
    },
    {
      type: 'belongsTo',
      name: 'createdBy',
      target: 'users',
    },
  ],
});
