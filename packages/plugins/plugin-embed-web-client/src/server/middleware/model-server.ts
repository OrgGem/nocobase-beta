/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Koa middleware: serves ONNX model files from local storage or S3.
 *
 * URL pattern:  GET /embed-web-client/models/{modelId}/{file}
 *
 * Lookup order:
 *   1. storage/plugin-embed-web-client/models/{modelId}/{file}  (user-uploaded, local)
 *   2. <plugin>/public/models/{modelId}/{file}                  (bundled)
 *   3. S3 bucket (when storageMode = 's3' and config is set)
 */

import { resolve, extname, normalize, join } from 'path';
import { createReadStream, existsSync, statSync } from 'fs';
import type { Context, Next } from '@nocobase/actions';
import type { Database } from '@nocobase/database';
import { createS3StorageFromConfigWithFileManager } from '../utils/s3-storage';

const URL_PREFIX = '/embed-web-client/models/';

const STORAGE_MODELS_ROOT = resolve(process.cwd(), 'storage/plugin-embed-web-client/models');
const EMBEDDED_MODELS_ROOT = resolve(__dirname, '../../../public/models');

const MIME_MAP: Record<string, string> = {
  '.json': 'application/json',
  '.onnx': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.txt': 'text/plain',
};

// Simple in-process S3 config cache — refreshed every 60 s to pick up admin changes
// without querying the DB on every file request.
interface CachedS3Config {
  config: Record<string, any> | null;
  fetchedAt: number;
}

let s3ConfigCache: CachedS3Config = { config: null, fetchedAt: 0 };
const S3_CACHE_TTL_MS = 60_000;

async function getS3Config(db: Database): Promise<Record<string, any> | null> {
  const now = Date.now();
  if (now - s3ConfigCache.fetchedAt < S3_CACHE_TTL_MS) {
    return s3ConfigCache.config;
  }

  try {
    const repo = db.getRepository('embedWebClientConfig');
    const config = await repo.findOne({ filter: {}, sort: ['id'] });
    s3ConfigCache = { config: config ?? null, fetchedAt: now };
    return s3ConfigCache.config;
  } catch {
    // DB might not be ready during startup — return cached value if any
    return s3ConfigCache.config;
  }
}

export function createModelServerMiddleware(db: Database, app?: any) {
  return async (ctx: Context, next: Next) => {
    if (!ctx.path.startsWith(URL_PREFIX)) {
      return next();
    }

    // Decode and normalize — prevents path traversal via encoded sequences
    const rawRelative = decodeURIComponent(ctx.path.slice(URL_PREFIX.length));
    const normalized = normalize(rawRelative);

    // Reject if normalization escapes the prefix (e.g. ../../etc/passwd)
    if (normalized.startsWith('..') || normalized.includes('\0')) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid path' };
      return;
    }

    // Validate BOTH local paths before any filesystem access to prevent traversal
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

    const ext = extname(normalized).toLowerCase();
    const mimeType = MIME_MAP[ext] ?? 'application/octet-stream';

    // 1. Prefer local user-uploaded storage
    if (existsSync(storagePath)) {
      return serveLocalFile(ctx, storagePath, mimeType);
    }

    // 2. Fall back to bundled models
    if (existsSync(bundledPath)) {
      return serveLocalFile(ctx, bundledPath, mimeType);
    }

    // 3. Try S3 if configured
    const pluginConfig = await getS3Config(db);
    const s3 = await createS3StorageFromConfigWithFileManager(pluginConfig ?? {}, app);

    if (s3) {
      // The browser requests: /embed-web-client/models/{modelId}/{file}
      // normalized = "{modelId}/{file}"
      // We need to reconstruct the S3 key. The key structure includes "resolve/main/".
      // The worker sets remotePathTemplate = 'embed-web-client/models/{model}/' which
      // means {file} paths do NOT include the "resolve/main" segment.
      // So we map: normalized → modelId = first two segments, filePath = rest
      const parts = normalized.replace(/\\/g, '/').split('/');
      if (parts.length >= 3) {
        const modelId = `${parts[0]}/${parts[1]}`;
        const filePath = parts.slice(2).join('/');
        const key = s3.buildKey(modelId, filePath);

        try {
          const { stream, contentLength } = await s3.getReadStream(key);
          ctx.type = mimeType;
          if (contentLength != null) {
            ctx.set('Content-Length', String(contentLength));
          }
          ctx.set('Cache-Control', 'public, max-age=86400');
          ctx.body = stream;
          return;
        } catch {
          // Not in S3 either — fall through to 404
        }
      }
    }

    ctx.status = 404;
    ctx.body = { error: 'Model file not found. Download the model first via plugin settings.' };
  };
}

function serveLocalFile(ctx: Context, absPath: string, mimeType: string) {
  const stat = statSync(absPath);
  if (!stat.isFile()) {
    ctx.status = 404;
    ctx.body = { error: 'Not a file' };
    return;
  }

  ctx.type = mimeType;
  ctx.set('Content-Length', String(stat.size));
  ctx.set('Cache-Control', 'public, max-age=86400'); // 24 h — model files are immutable
  ctx.body = createReadStream(absPath);
}
