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
