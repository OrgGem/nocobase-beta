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
    // ── Model source / CDN settings ─────────────────────────────────────────
    {
      // Where the browser should fetch model files from:
      //   'server'      — served by this NocoBase server (local disk or S3, default)
      //   'cdn'         — fetched from cdnBaseUrl configured below (no server needed)
      //   'huggingface' — fetched directly from HuggingFace Hub (requires internet)
      type: 'string',
      name: 'modelSource',
      defaultValue: 'server',
    },
    {
      // Full CDN URL pointing to the model folder.
      // Example: https://cdn.jsdelivr.net/npm/@alvix/all-minilm-l6-v2@1.0.1/dist/Xenova/all-MiniLM-L6-v2
      // The URL must end at the model folder (the directory that contains config.json, model.onnx, etc.)
      type: 'string',
      name: 'cdnBaseUrl',
    },
    // ── S3 / object-storage settings ────────────────────────────────────────
    {
      // 'local' = store model files on the NocoBase server disk (default)
      // 's3'    = store model files in an S3-compatible bucket
      type: 'string',
      name: 'storageMode',
      defaultValue: 'local',
    },
    {
      type: 'string',
      name: 's3Bucket',
    },
    {
      type: 'string',
      name: 's3Region',
    },
    {
      // Optional custom endpoint for MinIO / Cloudflare R2 / etc.
      type: 'string',
      name: 's3Endpoint',
    },
    {
      type: 'string',
      name: 's3AccessKeyId',
    },
    {
      // Stored encrypted at rest by the DB; never returned to the browser.
      type: 'password',
      name: 's3SecretAccessKey',
    },
    {
      // Key prefix inside the bucket (default: "embed-web-client")
      type: 'string',
      name: 's3KeyPrefix',
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
