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
      // Retained only to normalize settings saved before the canonical pipeline.
      name: 'mode',
      type: 'string',
      defaultValue: 'default',
      comment: 'Legacy compatibility field; not user-editable',
    },
    {
      // Retained only to normalize settings saved before the canonical pipeline.
      name: 'activeProviderId',
      type: 'bigInt',
      allowNull: true,
      comment: 'Legacy compatibility field; not user-editable',
    },
    {
      // Retained only to normalize settings saved before the canonical pipeline.
      name: 'fallbackToDefault',
      type: 'boolean',
      defaultValue: true,
      comment: 'Legacy compatibility field; not user-editable',
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
      name: 'pipeline',
      type: 'json',
      allowNull: true,
      comment: 'Canonical PDF and OCR pipeline configuration',
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
    {
      name: 'enableMarkitdown',
      type: 'boolean',
      defaultValue: true,
      comment: 'Enable python markitdown CLI for local parsing before fallback',
    },
  ],
});
