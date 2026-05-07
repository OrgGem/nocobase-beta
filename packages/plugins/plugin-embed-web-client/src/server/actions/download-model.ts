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
 * Fetches model files from HuggingFace Hub and saves them to either:
 *   - Local disk:  storage/plugin-embed-web-client/models/{model}/resolve/{revision}/{file}
 *   - S3 bucket:   {keyPrefix}/models/{model}/resolve/{revision}/{file}
 *     (when storageMode = 's3' in plugin config)
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
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Context, Next } from '@nocobase/actions';
import { DTYPE_ONNX, REQUIRED_BASE_FILES, DEFAULT_MODEL_ID, DEFAULT_DTYPE } from '../../shared/constants';
import { safeJoin } from '../../shared/utils';
import { createS3StorageFromConfigWithFileManager, modelFileMimeType } from '../utils/s3-storage';
import { VALID_MODEL_ID_RE } from './model-manager';

// Downloads go to storage/ so they survive plugin upgrades without overwriting bundled files
const MODELS_ROOT = resolve(process.cwd(), 'storage/plugin-embed-web-client/models');
const HF_BASE = 'https://huggingface.co';

// Maximum time (ms) to wait for a single file download from HuggingFace
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

async function downloadToBuffer(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'NocoBase-plugin-embed-web-client/1.0' },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function writeLocalFile(destPath: string, buffer: Buffer): void {
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

  // Strict validation — modelId must be "Org/ModelName" (ASCII only, max 128 chars each segment)
  if (!VALID_MODEL_ID_RE.test(modelId)) {
    ctx.throw(
      400,
      'Invalid modelId format. Expected "Org/ModelName" using only letters, digits, hyphens, underscores, or dots (max 128 chars each).',
    );
  }

  const onnxFile = DTYPE_ONNX[dtype];
  if (!onnxFile) {
    ctx.throw(400, `Unsupported dtype: ${dtype}. Supported: ${Object.keys(DTYPE_ONNX).join(', ')}`);
  }

  // Load plugin config to determine storage mode
  const configRepo = ctx.db.getRepository('embedWebClientConfig');
  const pluginConfig = await configRepo.findOne({ filter: {}, sort: ['id'] });
  const s3 = await createS3StorageFromConfigWithFileManager(pluginConfig ?? {}, ctx.app);

  const files = [...REQUIRED_BASE_FILES, onnxFile];
  const results: { file: string; status: 'ok' | 'skipped' | 'failed'; error?: string }[] = [];

  for (const file of files) {
    const url = `${HF_BASE}/${modelId}/resolve/${revision}/${file}`;

    try {
      if (s3) {
        const s3Key = s3.buildKey(modelId, file, revision);
        // ── S3 mode ──────────────────────────────────────────────────────────
        // Check if already in S3
        if (await s3.fileExists(s3Key)) {
          results.push({ file, status: 'skipped' });
          continue;
        }

        ctx.app.logger.info(`[downloadModel] Fetching ${url} → S3:${s3Key}`);
        const buffer = await downloadToBuffer(url);
        await s3.uploadFile(s3Key, buffer, modelFileMimeType(file));
        results.push({ file, status: 'ok' });
      } else {
        // ── Local disk mode ───────────────────────────────────────────────────
        const destPath = safeJoin(MODELS_ROOT, modelId, ...file.split('/'));

        if (existsSync(destPath)) {
          results.push({ file, status: 'skipped' });
          continue;
        }

        ctx.app.logger.info(`[downloadModel] Fetching ${url} → ${destPath}`);
        const buffer = await downloadToBuffer(url);
        writeLocalFile(destPath, buffer);
        results.push({ file, status: 'ok' });
      }
    } catch (err: any) {
      ctx.app.logger.error(`[downloadModel] Failed to download ${file}: ${err.message}`);
      results.push({ file, status: 'failed', error: err.message });
    }
  }

  const failed = results.filter((r) => r.status === 'failed');

  ctx.body = {
    modelId,
    dtype,
    revision,
    storageMode: s3 ? 's3' : 'local',
    results,
    success: failed.length === 0,
    error: failed.length > 0 ? `Failed to download: ${failed.map((r) => r.file).join(', ')}` : undefined,
  };

  await next();
}

/**
 * GET /embedWebClient:getModelStatus
 *
 * Checks whether the configured model is available (disk or S3).
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

  const s3 = await createS3StorageFromConfigWithFileManager(config ?? {}, ctx.app);

  // Check bundled models first, then storage override
  const BUNDLED_ROOT = resolve(__dirname, '../../public/models');
  const checkBase = (root: string) => safeJoin(root, modelId);

  const fileStatuses = await Promise.all(
    requiredFiles.map(async (file) => {
      const bundledPath = safeJoin(checkBase(BUNDLED_ROOT), ...file.split('/'));
      const storagePath = safeJoin(checkBase(MODELS_ROOT), ...file.split('/'));
      const onDisk = existsSync(bundledPath) || existsSync(storagePath);

      let inS3 = false;
      if (s3 && !onDisk) {
        const key = s3.buildKey(modelId, file, revision);
        inS3 = await s3.fileExists(key).catch(() => false);
      }

      return {
        file,
        present: onDisk || inS3,
        bundled: existsSync(bundledPath),
        onDisk,
        inS3,
      };
    }),
  );

  const downloaded = fileStatuses.every((f) => f.present);
  const bundled = fileStatuses.every((f) => f.bundled);

  ctx.body = {
    modelId,
    dtype,
    revision,
    downloaded,
    bundled,
    storageMode: s3 ? 's3' : 'local',
    files: fileStatuses,
  };

  await next();
}
