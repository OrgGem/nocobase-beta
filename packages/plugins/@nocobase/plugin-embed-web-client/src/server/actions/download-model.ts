/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Server-side model file downloader.
 *
 * Called by the admin "Download Model" button in plugin settings.
 * Fetches model files from HuggingFace Hub and saves them to:
 *   storage/plugin-embed-web-client/models/{model}/resolve/{revision}/{file}
 *
 * After a successful download the worker can fetch files from the local
 * model-server middleware instead of the internet.
 *
 * Required files for feature-extraction ONNX models:
 *   config.json
 *   tokenizer.json
 *   tokenizer_config.json
 *   special_tokens_map.json
 *   onnx/model_{dtype}.onnx  (e.g. model_q8.onnx)
 */

import { resolve, dirname } from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import type { Context, Next } from '@nocobase/actions';
import { DTYPE_ONNX, REQUIRED_BASE_FILES, DEFAULT_MODEL_ID, DEFAULT_DTYPE } from '../../shared/constants';
import { safeJoin } from '../../shared/utils';

// Downloads go to storage/ so they survive plugin upgrades without overwriting bundled files
const MODELS_ROOT = resolve(process.cwd(), 'storage/plugin-embed-web-client/models');
const HF_BASE = 'https://huggingface.co';

async function downloadFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'NocoBase-plugin-embed-web-client/1.0' },
  });

  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const dir = dirname(destPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(destPath, buffer);
}

/**
 * POST /embedWebClient:downloadModel
 *
 * Body (values): { modelId, dtype, revision? }
 * Admin-only (enforced via ACL snippet in plugin.ts).
 */
export async function downloadModel(ctx: Context, next: Next) {
  const { modelId, dtype = DEFAULT_DTYPE, revision = 'main' } = ctx.action.params.values ?? {};

  if (!modelId || typeof modelId !== 'string') {
    ctx.throw(400, 'modelId is required');
  }

  // Basic validation — modelId should look like "Org/model-name"
  if (!/^[\w.-]+\/[\w.-]+$/.test(modelId)) {
    ctx.throw(400, 'Invalid modelId format. Expected "Org/ModelName".');
  }

  const onnxFile = DTYPE_ONNX[dtype];
  if (!onnxFile) {
    ctx.throw(400, `Unsupported dtype: ${dtype}. Supported: ${Object.keys(DTYPE_ONNX).join(', ')}`);
  }

  const files = [...REQUIRED_BASE_FILES, onnxFile];
  const results: { file: string; status: 'ok' | 'failed'; error?: string }[] = [];
  const destBase = safeJoin(MODELS_ROOT, modelId, 'resolve', revision);

  for (const file of files) {
    const url = `${HF_BASE}/${modelId}/resolve/${revision}/${file}`;
    const destPath = safeJoin(destBase, ...file.split('/'));

    try {
      if (existsSync(destPath)) {
        results.push({ file, status: 'ok' }); // already cached
        continue;
      }
      await downloadFile(url, destPath);
      results.push({ file, status: 'ok' });
    } catch (err: any) {
      results.push({ file, status: 'failed', error: err.message });
    }
  }

  const failed = results.filter((r) => r.status === 'failed');

  ctx.body = {
    modelId,
    dtype,
    revision,
    results,
    success: failed.length === 0,
    error: failed.length > 0 ? `Failed to download: ${failed.map((r) => r.file).join(', ')}` : undefined,
  };

  await next();
}

/**
 * GET /embedWebClient:getModelStatus
 *
 * Checks whether the configured model is available on disk.
 * Returns { downloaded: boolean, files: string[] }
 */
export async function getModelStatus(ctx: Context, next: Next) {
  const configRepo = ctx.db.getRepository('embedWebClientConfig');
  const config = await configRepo.findOne({ filter: {}, sort: ['id'] });

  const modelId: string = config?.modelId ?? DEFAULT_MODEL_ID;
  const dtype: string = config?.dtype ?? DEFAULT_DTYPE;
  const revision = 'main';

  const onnxFile = DTYPE_ONNX[dtype] ?? DTYPE_ONNX.q8;
  const requiredFiles = [...REQUIRED_BASE_FILES, onnxFile];

  // Check bundled models first, then storage override
  const BUNDLED_ROOT = resolve(__dirname, '../../public/models');
  const checkBase = (root: string) => safeJoin(root, modelId, 'resolve', revision);

  const fileStatuses = requiredFiles.map((file) => {
    const bundledPath = safeJoin(checkBase(BUNDLED_ROOT), ...file.split('/'));
    const storagePath = safeJoin(checkBase(MODELS_ROOT), ...file.split('/'));
    const present = existsSync(bundledPath) || existsSync(storagePath);
    return { file, present, bundled: existsSync(bundledPath) };
  });

  const downloaded = fileStatuses.every((f) => f.present);
  const bundled = fileStatuses.every((f) => f.bundled);

  ctx.body = {
    modelId,
    dtype,
    revision,
    downloaded,
    bundled,
    files: fileStatuses,
  };

  await next();
}
