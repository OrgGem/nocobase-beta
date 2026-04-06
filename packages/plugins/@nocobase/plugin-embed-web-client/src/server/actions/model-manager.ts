/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Admin-only model management actions.
 *
 * Models live in two roots (checked in order):
 *   1. <plugin>/public/models/{modelId}/          — bundled, read-only
 *   2. storage/plugin-embed-web-client/models/{modelId}/ — user-uploaded, writable
 *
 * URL served: GET /embed-web-client/models/{modelId}/{file}
 */

import { resolve, join, dirname } from 'path';
import { existsSync, readdirSync, statSync, mkdirSync, writeFileSync, rmSync, readFileSync, copyFileSync } from 'fs';
import type { Context, Next } from '@nocobase/actions';
import { koaMulter as multer } from '@nocobase/utils';
import { DTYPE_ONNX, REQUIRED_BASE_FILES } from '../../shared/constants';
import { safeJoin } from '../../shared/utils';

export const BUNDLED_MODELS_ROOT = resolve(__dirname, '../../public/models');
export const STORAGE_MODELS_ROOT = resolve(process.cwd(), 'storage/plugin-embed-web-client/models');

// Re-export for backward compatibility
export { DTYPE_ONNX };

// ── helpers ────────────────────────────────────────────────────────────────

function readDimensions(modelRoot: string): number | null {
  try {
    const cfg = JSON.parse(readFileSync(join(modelRoot, 'config.json'), 'utf-8'));
    return cfg.hidden_size ?? cfg.d_model ?? null;
  } catch {
    return null;
  }
}

function calcDirSize(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += calcDirSize(p);
    else total += statSync(p).size;
  }
  return total;
}

function scanModels(root: string, source: 'bundled' | 'uploaded') {
  if (!existsSync(root)) return [];
  const results: any[] = [];

  for (const org of readdirSync(root, { withFileTypes: true })) {
    if (!org.isDirectory()) continue;
    const orgPath = join(root, org.name);
    for (const model of readdirSync(orgPath, { withFileTypes: true })) {
      if (!model.isDirectory()) continue;
      const modelId = `${org.name}/${model.name}`;
      const modelRoot = join(orgPath, model.name);

      // Detect available dtypes
      const availableDtypes: string[] = [];
      for (const [dtype, file] of Object.entries(DTYPE_ONNX)) {
        if (existsSync(join(modelRoot, file))) availableDtypes.push(dtype);
      }

      results.push({
        modelId,
        source,
        dimensions: readDimensions(modelRoot),
        availableDtypes,
        fileSizeBytes: calcDirSize(modelRoot),
        baseFilesReady: REQUIRED_BASE_FILES.every((f) => existsSync(join(modelRoot, f))),
      });
    }
  }
  return results;
}

// ── actions ────────────────────────────────────────────────────────────────

/**
 * GET /embedWebClient:listModels
 * Returns bundled + uploaded models with status.
 */
export async function listModels(ctx: Context, next: Next) {
  const bundled = scanModels(BUNDLED_MODELS_ROOT, 'bundled');
  const uploaded = scanModels(STORAGE_MODELS_ROOT, 'uploaded');

  // Deduplicate: if same modelId appears in both, the uploaded version overrides bundled
  const uploadedIds = new Set(uploaded.map((m) => m.modelId));
  const deduped = [...bundled.filter((m) => !uploadedIds.has(m.modelId)), ...uploaded];

  ctx.body = { data: deduped };
  await next();
}

/**
 * POST /embedWebClient:uploadModelFile   (admin only, multipart)
 *
 * Fields:
 *   modelId   — e.g. "myorg/my-model"
 *   filePath  — e.g. "onnx/model_quantized.onnx" or "config.json"
 *   file      — the binary file
 */
export async function uploadModelFile(ctx: Context, next: Next) {
  // Parse multipart via multer
  await new Promise<void>((resolve, reject) => {
    const storage = (multer as any).diskStorage({
      destination: (_req: any, _file: any, cb: any) => cb(null, require('os').tmpdir()),
      filename: (_req: any, _file: any, cb: any) => cb(null, `upload-${Date.now()}`),
    });
    const upload = (multer as any)({ storage }).single('file');
    upload(ctx, null, (err: any) => (err ? reject(err) : resolve()));
  });

  const { modelId, filePath } = ctx.request.body as any;
  const uploadedFile = (ctx as any).file;

  if (!modelId || !filePath || !uploadedFile) {
    ctx.throw(400, 'modelId, filePath, and file are required');
  }

  // Validate modelId
  if (!/^[\w.-]+\/[\w.-]+$/.test(modelId)) {
    ctx.throw(400, 'Invalid modelId. Expected "Org/ModelName".');
  }

  // Validate filePath (no traversal)
  const normalised = filePath.replace(/\\/g, '/');
  if (normalised.startsWith('..') || normalised.includes('\0') || normalised.includes('://')) {
    ctx.throw(400, 'Invalid filePath');
  }

  const destPath = safeJoin(join(STORAGE_MODELS_ROOT, modelId), normalised);
  mkdirSync(dirname(destPath), { recursive: true });
  copyFileSync(uploadedFile.path, destPath);

  // Clean up temp file
  try {
    rmSync(uploadedFile.path);
  } catch {
    /* ignore */
  }

  ctx.body = { success: true, modelId, filePath: normalised };
  await next();
}

/**
 * POST /embedWebClient:deleteModel   (admin only)
 *
 * Body (values): { modelId }
 * Only user-uploaded models can be deleted (bundled are read-only).
 */
export async function deleteModel(ctx: Context, next: Next) {
  const { modelId } = ctx.action.params.values ?? {};

  if (!modelId || !/^[\w.-]+\/[\w.-]+$/.test(modelId)) {
    ctx.throw(400, 'Valid modelId is required');
  }

  const modelRoot = join(STORAGE_MODELS_ROOT, modelId);
  if (!existsSync(modelRoot)) {
    ctx.throw(404, `Model "${modelId}" not found in user storage`);
  }

  // Safety: must stay inside STORAGE_MODELS_ROOT
  if (!modelRoot.startsWith(STORAGE_MODELS_ROOT)) {
    ctx.throw(403, 'Forbidden');
  }

  rmSync(modelRoot, { recursive: true, force: true });
  ctx.body = { success: true, modelId };
  await next();
}

/**
 * GET /embedWebClient:getModelFiles   (admin only)
 *
 * Returns per-file presence status for a given model + dtype.
 * Query params: modelId, dtype
 */
export async function getModelFiles(ctx: Context, next: Next) {
  const { modelId, dtype = 'q8' } = ctx.action.params ?? {};

  if (!modelId) {
    ctx.throw(400, 'modelId required');
  }

  const onnxFile = DTYPE_ONNX[dtype] ?? DTYPE_ONNX.q8;
  const requiredFiles = [...REQUIRED_BASE_FILES, onnxFile];

  function check(root: string) {
    const base = join(root, modelId);
    return requiredFiles.map((f) => ({
      file: f,
      present: existsSync(join(base, f)),
      source: root === BUNDLED_MODELS_ROOT ? 'bundled' : 'uploaded',
    }));
  }

  const bundled = check(BUNDLED_MODELS_ROOT);
  const uploaded = check(STORAGE_MODELS_ROOT);

  // Merge: if same file present in both, prefer uploaded
  const merged = requiredFiles.map((f) => {
    const b = bundled.find((x) => x.file === f)!;
    const u = uploaded.find((x) => x.file === f)!;
    return u.present ? u : b;
  });

  ctx.body = {
    modelId,
    dtype,
    files: merged,
    ready: merged.every((f) => f.present),
  };
  await next();
}
