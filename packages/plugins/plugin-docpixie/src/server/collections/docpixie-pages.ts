/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * DocPixie Pages — Collection Definition
 *
 * Stores extracted page data for each document page.
 * Each page holds its structured text, layout regions, and metadata.
 */
import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'docpixie_pages',
  title: 'DocPixie Pages',
  fields: [
    { type: 'bigInt', name: 'id', primaryKey: true, autoIncrement: true },
    {
      type: 'belongsTo',
      name: 'document',
      target: 'docpixie_documents',
      foreignKey: 'documentId',
    },
    { type: 'integer', name: 'pageNumber' },
    { type: 'string', name: 'imagePath', length: 1000 },
    { type: 'text', name: 'structuredText' },
    { type: 'json', name: 'regions', defaultValue: [] },
    { type: 'boolean', name: 'hasTables', defaultValue: false },
    { type: 'boolean', name: 'hasFigures', defaultValue: false },
    { type: 'json', name: 'headings', defaultValue: [] },
    {
      type: 'string',
      name: 'extractionMethod',
      length: 20,
      defaultValue: 'text_layer',
    },
    { type: 'json', name: 'metadata', defaultValue: {} },
  ],
});
