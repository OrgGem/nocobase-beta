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
  name: 'aiKnowledgeBaseSearchAnalytics',
  title: 'Knowledge Base Search Analytics',
  fields: [
    {
      type: 'bigInt',
      name: 'id',
      autoIncrement: true,
      primaryKey: true,
    },
    {
      type: 'uid',
      name: 'knowledgeBaseId',
    },
    {
      type: 'string',
      name: 'query',
      length: 2000,
    },
    {
      type: 'integer',
      name: 'resultCount',
      defaultValue: 0,
    },
    {
      // Latency in milliseconds
      type: 'integer',
      name: 'searchLatencyMs',
    },
    {
      type: 'bigInt',
      name: 'userId',
    },
    {
      type: 'date',
      name: 'createdAt',
    },
  ],
  indexes: [{ fields: ['knowledgeBaseId', 'createdAt'] }, { fields: ['query'] }],
});
