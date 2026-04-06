/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Koa middleware: serves ONNX model files from local storage.
 *
 * URL pattern:  GET /embed-web-client/models/{modelId}/{file}
 *
 * The browser worker sets:
 *   env.remoteHost         = `${origin}/`
 *   env.remotePathTemplate = `embed-web-client/models/{model}/`
 *   (revision is intentionally ignored — we only support "main")
 *
 * So a request for config.json of Xenova/all-MiniLM-L6-v2 becomes:
 *   GET /embed-web-client/models/Xenova/all-MiniLM-L6-v2/config.json
 *
 * Lookup order:
 *   1. storage/plugin-embed-web-client/models/{modelId}/{file}  (user-uploaded)
 *   2. <plugin>/public/models/{modelId}/{file}                  (bundled)
 */

import { resolve, extname, normalize, join } from 'path';
import { createReadStream, existsSync, statSync } from 'fs';
import type { Context, Next } from '@nocobase/actions';

const URL_PREFIX = '/embed-web-client/models/';

const STORAGE_MODELS_ROOT = resolve(process.cwd(), 'storage/plugin-embed-web-client/models');
const EMBEDDED_MODELS_ROOT = resolve(__dirname, '../../public/models');

const MIME_MAP: Record<string, string> = {
  '.json': 'application/json',
  '.onnx': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.txt': 'text/plain',
};

export function createModelServerMiddleware() {
  return async (ctx: Context, next: Next) => {
    if (!ctx.path.startsWith(URL_PREFIX)) {
      return next();
    }

    // Decode and normalize — prevents path traversal
    const rawRelative = decodeURIComponent(ctx.path.slice(URL_PREFIX.length));
    const normalized = normalize(rawRelative);

    // Reject if normalization escapes the prefix (e.g. ../../etc/passwd)
    if (normalized.startsWith('..') || normalized.includes('\0')) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid path' };
      return;
    }

    // Validate BOTH paths before any filesystem access to prevent traversal
    const bundledPath = join(EMBEDDED_MODELS_ROOT, normalized);
    const storagePath = join(STORAGE_MODELS_ROOT, normalized);

    if (!bundledPath.startsWith(EMBEDDED_MODELS_ROOT)) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }
    if (!storagePath.startsWith(STORAGE_MODELS_ROOT)) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    // Prefer storage (user-uploaded) over bundled
    let absPath: string;
    if (existsSync(storagePath)) {
      absPath = storagePath;
    } else if (existsSync(bundledPath)) {
      absPath = bundledPath;
    } else {
      ctx.status = 404;
      ctx.body = { error: 'Model file not found. Download the model first via plugin settings.' };
      return;
    }

    const stat = statSync(absPath);
    if (!stat.isFile()) {
      ctx.status = 404;
      ctx.body = { error: 'Not a file' };
      return;
    }

    const ext = extname(absPath).toLowerCase();
    ctx.type = MIME_MAP[ext] ?? 'application/octet-stream';
    ctx.set('Content-Length', String(stat.size));
    ctx.set('Cache-Control', 'public, max-age=86400'); // 24h — model files are immutable
    ctx.body = createReadStream(absPath);
  };
}
