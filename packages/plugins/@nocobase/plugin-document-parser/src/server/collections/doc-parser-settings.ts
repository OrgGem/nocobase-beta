/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { defineCollection } from '@nocobase/database';

/**
 * Global settings for the document parser plugin.
 * Single-row config table (only one record expected).
 */
export default defineCollection({
  name: 'docParserSettings',
  title: 'Document Parser Settings',
  fields: [
    {
      name: 'mode',
      type: 'string',
      defaultValue: 'default',
      comment: "'default' | 'internal' | 'external'",
    },
    {
      // FK to docParserProviders — which external provider is active
      name: 'activeProviderId',
      type: 'bigInt',
      allowNull: true,
    },
    {
      // When internal/external parsing fails, fall back to the default provider logic
      name: 'fallbackToDefault',
      type: 'boolean',
      defaultValue: true,
    },
    {
      // Images are always passed through to the default provider (they don't need OCR)
      name: 'imagePassThrough',
      type: 'boolean',
      defaultValue: true,
    },
    {
      // Optional: restrict which extnames this plugin handles (empty = all non-image)
      name: 'includedExtnames',
      type: 'json',
      defaultValue: [],
      comment: 'e.g. [".pdf", ".docx"] — empty means all non-image files',
    },
    {
      name: 'options',
      type: 'json',
      defaultValue: {},
    },
    {
      /**
       * When true and plugin-docpixie is active:
       * - Trigger docpixie:processDocument (async indexing)
       * - Return a metadata reference block instead of full text
       * - LLM is instructed to call docpixie:query tool for retrieval
       */
      name: 'useDocpixie',
      type: 'boolean',
      defaultValue: false,
    },
  ],
});
