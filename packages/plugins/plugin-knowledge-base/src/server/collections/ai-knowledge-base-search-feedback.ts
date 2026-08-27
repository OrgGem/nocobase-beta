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
  name: 'aiKnowledgeBaseSearchFeedback',
  title: 'Knowledge Base Search Feedback',
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
      type: 'string',
      name: 'documentId',
      length: 100,
    },
    {
      // positive | negative
      type: 'string',
      name: 'feedback',
      length: 20,
    },
    {
      // Rerank score at time of feedback
      type: 'double',
      name: 'rerankScore',
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
  indexes: [{ fields: ['knowledgeBaseId', 'createdAt'] }, { fields: ['query'] }, { fields: ['documentId'] }],
});
