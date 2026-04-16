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
 *   3. S3 bucket (when storageMode = 's3')
 *
 * URL served: GET /embed-web-client/models/{modelId}/{file}
 */

import { resolve, join, dirname } from 'path';
import { existsSync, readdirSync, statSync, mkdirSync, rmSync, readFileSync } from 'fs';
import type { Context, Next } from '@nocobase/actions';
import { koaMulter as multer } from '@nocobase/utils';
import { DTYPE_ONNX, REQUIRED_BASE_FILES } from '../../shared/constants';
import { safeJoin } from '../../shared/utils';
import { createS3StorageFromConfig, modelFileMimeType } from '../utils/s3-storage';

export const BUNDLED_MODELS_ROOT = resolve(__dirname, '../../public/models');
export const STORAGE_MODELS_ROOT = resolve(process.cwd(), 'storage/plugin-embed-web-client/models');

// Re-export for backward compatibility
export { DTYPE_ONNX };

/**
 * Strict model ID regex:
 *   - Only ASCII letters, digits, hyphens, underscores, dots
 *   - Max 128 chars per segment
 *   - Must be exactly "Org/ModelName"
 */
export const VALID_MODEL_ID_RE = /^[a-zA-Z0-9._-]{1,128}\/[a-zA-Z0-9._-]{1,128}$/;

// Max upload file size: 2 GB (large ONNX models can be very big)
const MAX_UPLOAD_SIZE_BYTES = 2 * 1024 * 1024 * 1024;

// Allowed file extensions for model file uploads
const ALLOWED_EXTENSIONS = new Set(['.json', '.onnx', '.bin', '.txt']);

// Magic bytes for allowed binary formats
// ONNX files start with 0x08 (protobuf field tag)
// JSON files start with { or [
// We do a lightweight check — not a full format validator
function validateFileBytes(buffer: Buffer, filename: string): void {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';

  if (ext === 'onnx' || ext === 'bin') {
    // Protobuf files typically start with 0x0a or 0x08 (field tags 1/2)
    if (buffer.length < 4) throw new Error('File too small to be a valid ONNX/binary model file');
    // Not enforcing a strict magic-byte check — ONNX protobuf can start with many values.
    // We at least reject HTML error pages (common when wrong URL served).
    const first = buffer.toString('ascii', 0, Math.min(buffer.length, 16));
    if (first.startsWith('<!') || first.startsWith('<h') || first.startsWith('<?')) {
      throw new Error('Uploaded file appears to be HTML, not a binary model file');
    }
    return;
  }

  if (ext === 'json') {
    try {
      const text = buffer.toString('utf-8', 0, Math.min(buffer.length, 4));
      if (!text.startsWith('{') && !text.startsWith('[')) {
        throw new Error('JSON file must start with { or [');
      }
    } catch {
      throw new Error('Invalid JSON file');
    }
    return;
  }

  if (ext === 'txt') return; // plain text, no special validation

  throw new Error(`Unsupported file extension: .${ext}`);
}

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

interface ModelInfo {
  modelId: string;
  source: 'bundled' | 'uploaded' | 's3';
  dimensions: number | null;
  availableDtypes: string[];
  fileSizeBytes: number;
  baseFilesReady: boolean;
}

function scanLocalModels(root: string, source: 'bundled' | 'uploaded'): ModelInfo[] {
  if (!existsSync(root)) return [];
  const results: ModelInfo[] = [];

  for (const org of readdirSync(root, { withFileTypes: true })) {
    if (!org.isDirectory()) continue;
    const orgPath = join(root, org.name);
    for (const model of readdirSync(orgPath, { withFileTypes: true })) {
      if (!model.isDirectory()) continue;
      const modelId = `${org.name}/${model.name}`;
      const modelRoot = join(orgPath, model.name);

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
 * Returns bundled + uploaded + S3 models with status.
 */
export async function listModels(ctx: Context, next: Next) {
  const bundled = scanLocalModels(BUNDLED_MODELS_ROOT, 'bundled');
  const uploaded = scanLocalModels(STORAGE_MODELS_ROOT, 'uploaded');

  // Check S3 for additional models
  const configRepo = ctx.db.getRepository('embedWebClientConfig');
  const pluginConfig = await configRepo.findOne({ filter: {}, sort: ['id'] });
  const s3 = createS3StorageFromConfig(pluginConfig ?? {});

  let s3Models: ModelInfo[] = [];
  if (s3) {
    const s3ModelIds = await s3.listModelIds().catch(() => [] as string[]);
    s3Models = s3ModelIds.map((modelId) => ({
      modelId,
      source: 's3' as const,
      dimensions: null, // We don't read config.json from S3 at list time (expensive)
      availableDtypes: [],
      fileSizeBytes: 0,
      baseFilesReady: true, // Assume complete — user downloaded via downloadModel
    }));
  }

  // Deduplicate: uploaded > s3 > bundled
  const uploadedIds = new Set(uploaded.map((m) => m.modelId));
  const s3Ids = new Set(s3Models.map((m) => m.modelId));
  const deduped = [
    ...bundled.filter((m) => !uploadedIds.has(m.modelId) && !s3Ids.has(m.modelId)),
    ...s3Models.filter((m) => !uploadedIds.has(m.modelId)),
    ...uploaded,
  ];

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
  // Parse multipart via multer with file size enforcement
  const storage = (multer as any).diskStorage({
    destination: (_req: any, _file: any, cb: any) => cb(null, require('os').tmpdir()),
    filename: (_req: any, _file: any, cb: any) =>
      cb(null, `ewc-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`),
  });
  const upload = (multer as any)({
    storage,
    limits: { fileSize: MAX_UPLOAD_SIZE_BYTES },
  }).single('file');

  try {
    await upload(ctx, async () => {});
  } catch (err: any) {
    ctx.throw(400, err instanceof Error ? err.message : String(err));
  }

  const { modelId, filePath } = ctx.request.body as any;
  const uploadedFile = (ctx as any).file;

  if (!modelId || !filePath || !uploadedFile) {
    ctx.throw(400, 'modelId, filePath, and file are required');
  }

  // Strict modelId validation
  if (!VALID_MODEL_ID_RE.test(modelId)) {
    ctx.throw(
      400,
      'Invalid modelId. Expected "Org/ModelName" using only letters, digits, hyphens, underscores, or dots.',
    );
  }

  // Validate filePath (no traversal, no absolute paths)
  const normalised = filePath.replace(/\\/g, '/');
  if (
    normalised.startsWith('..') ||
    normalised.startsWith('/') ||
    normalised.includes('\0') ||
    normalised.includes('://')
  ) {
    ctx.throw(400, 'Invalid filePath');
  }

  // Extension whitelist
  const ext = '.' + (normalised.split('.').pop()?.toLowerCase() ?? '');
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    ctx.throw(400, `Unsupported file extension: ${ext}. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}`);
  }

  // Read file for validation, then decide where to store
  const { readFileSync } = await import('fs');
  const fileBuffer = readFileSync(uploadedFile.path);

  // Validate file contents (magic bytes / format check)
  try {
    validateFileBytes(fileBuffer, normalised);
  } catch (err: any) {
    ctx.throw(400, `File validation failed: ${err.message}`);
  }

  // Load config to determine storage mode
  const configRepo = ctx.db.getRepository('embedWebClientConfig');
  const pluginConfig = await configRepo.findOne({ filter: {}, sort: ['id'] });
  const s3 = createS3StorageFromConfig(pluginConfig ?? {});

  try {
    if (s3) {
      // ── S3 mode ────────────────────────────────────────────────────────────
      const key = s3.buildKey(modelId, normalised);
      await s3.uploadFile(key, fileBuffer, modelFileMimeType(normalised));
    } else {
      // ── Local disk mode ────────────────────────────────────────────────────
      const destPath = safeJoin(join(STORAGE_MODELS_ROOT, modelId), normalised);
      mkdirSync(dirname(destPath), { recursive: true });
      const { copyFileSync } = await import('fs');
      copyFileSync(uploadedFile.path, destPath);
    }
  } finally {
    // Always clean up the temp file
    try {
      rmSync(uploadedFile.path);
    } catch {
      /* ignore */
    }
  }

  ctx.body = {
    success: true,
    modelId,
    filePath: normalised,
    storageMode: s3 ? 's3' : 'local',
  };
  await next();
}

/**
 * POST /embedWebClient:deleteModel   (admin only)
 *
 * Body (values): { modelId }
 * Only user-uploaded / S3 models can be deleted (bundled are read-only).
 */
export async function deleteModel(ctx: Context, next: Next) {
  const { modelId } = ctx.action.params.values ?? {};

  if (!modelId || !VALID_MODEL_ID_RE.test(modelId)) {
    ctx.throw(400, 'Valid modelId is required');
  }

  // Load config to determine storage mode
  const configRepo = ctx.db.getRepository('embedWebClientConfig');
  const pluginConfig = await configRepo.findOne({ filter: {}, sort: ['id'] });
  const s3 = createS3StorageFromConfig(pluginConfig ?? {});

  let deleted = false;

  // Delete from local storage if present
  const modelRoot = join(STORAGE_MODELS_ROOT, modelId);
  if (existsSync(modelRoot)) {
    // Safety: must stay inside STORAGE_MODELS_ROOT
    if (!modelRoot.startsWith(STORAGE_MODELS_ROOT + require('path').sep) && modelRoot !== STORAGE_MODELS_ROOT) {
      ctx.throw(403, 'Forbidden');
    }
    rmSync(modelRoot, { recursive: true, force: true });
    deleted = true;
  }

  // Delete from S3 if configured
  if (s3) {
    const prefix = s3.buildKey(modelId, '').replace(/\/$/, '') + '/';
    const keys = await s3.listKeys(prefix).catch(() => [] as string[]);
    if (keys.length > 0) {
      await s3.deletePrefix(prefix);
      deleted = true;
    }
  }

  if (!deleted) {
    ctx.throw(404, `Model "${modelId}" not found in user storage or S3`);
  }

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

  // Load config for S3
  const configRepo = ctx.db.getRepository('embedWebClientConfig');
  const pluginConfig = await configRepo.findOne({ filter: {}, sort: ['id'] });
  const s3 = createS3StorageFromConfig(pluginConfig ?? {});

  function checkLocal(root: string, source: 'bundled' | 'uploaded') {
    const base = join(root, modelId);
    return requiredFiles.map((f) => ({
      file: f,
      present: existsSync(join(base, f)),
      source,
    }));
  }

  const bundled = checkLocal(BUNDLED_MODELS_ROOT, 'bundled');
  const uploaded = checkLocal(STORAGE_MODELS_ROOT, 'uploaded');

  // Check S3 existence for files not found locally
  const merged = await Promise.all(
    requiredFiles.map(async (f) => {
      const b = bundled.find((x) => x.file === f)!;
      const u = uploaded.find((x) => x.file === f)!;
      if (u.present) return u;
      if (b.present) return b;

      // Check S3
      if (s3) {
        const key = s3.buildKey(modelId, f);
        const inS3 = await s3.fileExists(key).catch(() => false);
        if (inS3) return { file: f, present: true, source: 's3' as const };
      }

      return { ...b, present: false };
    }),
  );

  ctx.body = {
    modelId,
    dtype,
    files: merged,
    ready: merged.every((f) => f.present),
  };
  await next();
}

/**
 * POST /embedWebClient:createModelDirectory   (admin only)
 * Explicitly creates the local directory for a model (or S3 placeholder prefix)
 * so that it appears in "Installed Models" and is "saved" even if empty.
 */
export async function createModelDirectory(ctx: Context, next: Next) {
  const { modelId } = ctx.request.body as any;
  if (!modelId || !VALID_MODEL_ID_RE.test(modelId)) {
    ctx.throw(400, 'Valid modelId is required');
  }

  const configRepo = ctx.db.getRepository('embedWebClientConfig');
  const pluginConfig = await configRepo.findOne({ filter: {}, sort: ['id'] });
  const s3 = createS3StorageFromConfig(pluginConfig ?? {});

  if (!s3) {
    const destPath = safeJoin(join(STORAGE_MODELS_ROOT, modelId), 'placeholder');
    mkdirSync(dirname(destPath), { recursive: true });
  }

  ctx.body = { success: true, modelId };
  await next();
}
