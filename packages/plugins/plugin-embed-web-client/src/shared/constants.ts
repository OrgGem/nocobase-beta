/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Shared constants used by both server and client code.
 */

// Dtype → ONNX filename mapping (matches @huggingface/transformers JS naming convention)
// Source: node_modules/@huggingface/transformers/src/utils/dtypes.js
//   q8  → '_quantized' → model_quantized.onnx
//   q4  → '_q4'        → model_q4.onnx
//   fp16 → '_fp16'     → model_fp16.onnx
//   fp32 → ''          → model.onnx
export const DTYPE_ONNX: Record<string, string> = {
  q4: 'onnx/model_q4.onnx',
  q8: 'onnx/model_quantized.onnx',
  fp16: 'onnx/model_fp16.onnx',
  fp32: 'onnx/model.onnx',
};

// Files required for any ONNX feature-extraction model (tokenizer + config)
export const REQUIRED_BASE_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
];

// Default model settings
export const DEFAULT_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
export const DEFAULT_DTYPE = 'q8';
export const DEFAULT_DIMENSIONS = 384;
export const DEFAULT_CHUNK_SIZE = 1000;
export const DEFAULT_CHUNK_OVERLAP = 200;
export const DEFAULT_BATCH_SIZE = 16;

// Offline/private deployment: the browser always loads model files from the
// NocoBase server route, which serves bundled or admin-uploaded files.
export const OFFLINE_MODEL_SOURCE = 'server';

/**
 * Strict model ID regex:
 *   - Only ASCII letters, digits, hyphens, underscores, dots
 *   - Max 128 chars per segment
 *   - Must be exactly "Org/ModelName"
 */
export const VALID_MODEL_ID_RE = /^[a-zA-Z0-9._-]{1,128}\/[a-zA-Z0-9._-]{1,128}$/;
