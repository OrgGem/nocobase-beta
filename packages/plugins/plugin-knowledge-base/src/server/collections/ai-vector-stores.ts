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
  name: 'aiVectorStores',
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
      type: 'belongsTo',
      name: 'vectorDatabase',
      target: 'aiVectorDatabases',
      foreignKey: 'vectorDatabaseId',
    },
    {
      // LLM service name (references llmServices collection)
      type: 'string',
      name: 'llmService',
    },
    {
      // Embedding model name, e.g. text-embedding-3-small
      type: 'string',
      name: 'embeddingModel',
    },
    {
      // 'llmService' (default, remote API) or 'localEmbed' (ONNX via plugin-embed-web-client)
      type: 'string',
      name: 'embeddingProvider',
      defaultValue: 'llmService',
    },
    {
      // HuggingFace model ID for local ONNX embedding (e.g. "Xenova/all-MiniLM-L6-v2")
      type: 'string',
      name: 'localEmbedModelId',
    },
    {
      // ONNX quantization dtype for local embedding (e.g. "q4", "q8", "fp16", "fp32")
      type: 'string',
      name: 'localEmbedDtype',
    },
    {
      type: 'json',
      name: 'options',
    },
    {
      type: 'boolean',
      name: 'enabled',
      defaultValue: true,
    },
  ],
});
