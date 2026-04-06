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
 * Singleton configuration table for the Web Client Embedding plugin.
 * Only one row is expected (row id=1). Use the getConfig/updateConfig actions to read/write it.
 */
export default defineCollection({
  name: 'embedWebClientConfig',
  fields: [
    {
      type: 'bigInt',
      name: 'id',
      primaryKey: true,
      autoIncrement: true,
    },
    {
      // Model ID on HuggingFace — must be an ONNX-compatible feature-extraction model
      type: 'string',
      name: 'modelId',
      defaultValue: 'Xenova/all-MiniLM-L6-v2',
    },
    {
      // Quantization dtype: q4, q8, fp16, fp32
      type: 'string',
      name: 'dtype',
      defaultValue: 'q8',
    },
    {
      // Output embedding dimension — MUST match the vector store's configured dimension
      type: 'integer',
      name: 'dimensions',
      defaultValue: 384,
    },
    {
      // RecursiveCharacterTextSplitter chunk size (characters)
      type: 'integer',
      name: 'chunkSize',
      defaultValue: 1000,
    },
    {
      // RecursiveCharacterTextSplitter chunk overlap (characters)
      type: 'integer',
      name: 'chunkOverlap',
      defaultValue: 200,
    },
    {
      // Number of texts embedded in each batch call to the model
      type: 'integer',
      name: 'batchSize',
      defaultValue: 16,
    },
    {
      // Whether to attempt WebGPU acceleration (falls back to WASM gracefully)
      type: 'boolean',
      name: 'preferWebGPU',
      defaultValue: true,
    },
    {
      type: 'date',
      name: 'createdAt',
    },
    {
      type: 'date',
      name: 'updatedAt',
    },
  ],
});
