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
  name: 'aiKnowledgeBases',
  fields: [
    {
      type: 'uid',
      name: 'id',
      primaryKey: true,
    },
    {
      type: 'string',
      name: 'name',
      length: 255,
    },
    {
      type: 'text',
      name: 'description',
    },
    {
      // LOCAL | READONLY | EXTERNAL | EXTERNAL_RAG
      type: 'string',
      name: 'type',
      defaultValue: 'LOCAL',
    },
    {
      // Reference to plugin-file-manager storage
      type: 'string',
      name: 'fileStorage',
    },
    {
      type: 'belongsTo',
      name: 'vectorStore',
      target: 'aiVectorStores',
      foreignKey: 'vectorStoreId',
    },
    {
      type: 'boolean',
      name: 'enabled',
      defaultValue: true,
    },
    {
      // BASIC (per-user) | SHARED (role-based) | PUBLIC (system-wide)
      type: 'string',
      name: 'accessLevel',
      defaultValue: 'PUBLIC',
    },
    {
      // Owner userId (for BASIC KBs — only this user can access)
      type: 'bigInt',
      name: 'ownerId',
    },
    {
      // Roles allowed to query/view (for SHARED KBs)
      type: 'array',
      name: 'allowedRoles',
    },
    {
      // How AI Employees (agents) may reach this KB when running tools:
      //   inherit  — ride on the triggering user's access (default)
      //   explicit — only agents named in allowedAgents (or holding a role in allowedRoles)
      //   none     — no agent may ever read/use this KB
      type: 'string',
      name: 'agentAccess',
      defaultValue: 'inherit',
    },
    {
      // AI Employee usernames explicitly granted access when agentAccess === 'explicit'
      type: 'array',
      name: 'allowedAgents',
    },
    {
      // Legacy field. SHARED KBs now use allowedRoles for read/use/manage.
      type: 'array',
      name: 'uploadRoles',
    },
    {
      // Extra configuration per knowledge base type.
      // For EXTERNAL_RAG:
      //   ragProvider: string        — strategy name (default: 'external-http')
      //   ragApiUrl: string          — (required for external-http) POST endpoint URL
      //   ragApiKey: string          — (optional) Bearer token for Authorization header
      //   ragNamespace: string       — (optional) namespace forwarded in request body
      //   ragTopK: number            — (optional) overrides default topK
      //   ragScoreThreshold: number  — (optional) overrides default score threshold
      type: 'json',
      name: 'options',
    },
    {
      // If true, source files are deleted after successful vectorization
      type: 'boolean',
      name: 'deleteSourceFile',
      defaultValue: false,
    },
    {
      // If true, documents are also indexed into DocPixie (when plugin-docpixie is active).
      // DocPixie text is used for embedding (better OCR), and docpixie_document_id is stored
      // in chunk metadata to enable Stage 2 deep retrieval during AI chat.
      type: 'boolean',
      name: 'useDocpixie',
      defaultValue: false,
    },
    {
      type: 'hasMany',
      name: 'documents',
      target: 'aiKnowledgeBaseDocuments',
      foreignKey: 'knowledgeBaseId',
    },
  ],
});
