/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * DocPixie Logs — Collection Definition
 *
 * Stores detailed history of DocPixie adaptive RAG queries and invocations.
 */
import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'docpixie_logs',
  title: 'DocPixie Logs',
  fields: [
    { type: 'bigInt', name: 'id', primaryKey: true, autoIncrement: true },
    { type: 'text', name: 'query' },
    { type: 'text', name: 'answer' },
    { type: 'json', name: 'documentIds', defaultValue: [] },
    { type: 'string', name: 'strategy', length: 20 },
    { type: 'float', name: 'confidence', defaultValue: 0.0 },
    { type: 'float', name: 'totalCost', defaultValue: 0.0 },
    { type: 'float', name: 'processingTime', defaultValue: 0.0 },
    { type: 'string', name: 'status', length: 20, defaultValue: 'success' },
    { type: 'text', name: 'error' },
    {
      type: 'belongsTo',
      name: 'user',
      target: 'users',
      foreignKey: 'userId',
    },
    { type: 'date', name: 'createdAt' },
  ],
});
