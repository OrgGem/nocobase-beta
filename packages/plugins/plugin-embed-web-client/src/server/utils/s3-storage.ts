/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * S3-compatible storage helper for ONNX model files.
 *
 * Supports AWS S3 and any S3-compatible endpoint (MinIO, Cloudflare R2, etc.).
 * Used by download-model, model-manager, and model-server when storageMode = 's3'.
 */

import {
  S3Client,
  GetObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { Readable } from 'stream';
import { Readable as NodeReadable } from 'stream';

export interface S3Config {
  bucket: string;
  region: string;
  /** Optional custom endpoint for MinIO / Cloudflare R2 / etc. */
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Key prefix inside the bucket — defaults to "embed-web-client" */
  keyPrefix?: string;
}

function createS3Client(config: S3Config): S3Client {
  const client = new S3Client({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    // Required for MinIO / custom endpoints.
    forcePathStyle: !!config.endpoint,
    // Match File Manager S3 behavior for S3-compatible providers.
    requestChecksumCalculation: 'WHEN_REQUIRED',
  } as any);
  client.middlewareStack.remove('flexibleChecksumsMiddleware');
  client.middlewareStack.remove('flexibleChecksumsInputMiddleware');
  return client;
}

export class S3ModelStorage {
  private client: S3Client;
  private bucket: string;
  private keyPrefix: string;

  constructor(config: S3Config) {
    this.client = createS3Client(config);
    this.bucket = config.bucket;
    this.keyPrefix = (config.keyPrefix ?? 'embed-web-client').replace(/\/$/, '');
  }

  /**
   * Build an S3 key for a model file.
   * Structure: {keyPrefix}/models/{modelId}/resolve/{revision}/{filePath}
   */
  buildKey(modelId: string, filePath: string, revision = 'main'): string {
    // Normalise filePath to forward slashes
    const normFile = filePath.replace(/\\/g, '/');
    return `${this.keyPrefix}/models/${modelId}/resolve/${revision}/${normFile}`;
  }

  /** Returns the key prefix used for listing model directories. */
  modelsPrefix(): string {
    return `${this.keyPrefix}/models/`;
  }

  async fileExists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async uploadFile(key: string, data: Buffer, contentType = 'application/octet-stream'): Promise<void> {
    const upload = new Upload({
      client: this.client as any,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: NodeReadable.from(data),
        ContentType: contentType,
      },
      queueSize: 1,
      leavePartsOnError: false,
    });
    await upload.done();
  }

  async downloadToBuffer(key: string): Promise<Buffer> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const stream = response.Body as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  /** Opens a readable stream from S3 — used by model-server to proxy files. */
  async getReadStream(key: string): Promise<{ stream: Readable; contentLength?: number }> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return {
      stream: response.Body as Readable,
      contentLength: response.ContentLength,
    };
  }

  /**
   * List all keys under a prefix.
   * Handles pagination automatically.
   */
  async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of response.Contents ?? []) {
        if (obj.Key) keys.push(obj.Key);
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);

    return keys;
  }

  /**
   * Delete all objects under a key prefix (i.e. a whole model directory).
   */
  async deletePrefix(prefix: string): Promise<void> {
    const keys = await this.listKeys(prefix);
    if (keys.length === 0) return;

    // S3 supports up to 1 000 objects per batch-delete request
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((k) => ({ Key: k })) },
        }),
      );
    }
  }

  /**
   * Discover distinct model IDs stored under the models prefix.
   * Parses keys like: {keyPrefix}/models/{org}/{model}/resolve/main/...
   * Returns an array of "org/model" strings.
   */
  async listModelIds(): Promise<string[]> {
    const keys = await this.listKeys(this.modelsPrefix());
    const modelIds = new Set<string>();

    for (const key of keys) {
      // Strip leading prefix: "{keyPrefix}/models/"
      const relative = key.slice(this.modelsPrefix().length);
      // Expected: "{org}/{model}/resolve/{revision}/{file}"
      const parts = relative.split('/');
      if (parts.length >= 2) {
        modelIds.add(`${parts[0]}/${parts[1]}`);
      }
    }

    return Array.from(modelIds);
  }
}

/**
 * Build an S3ModelStorage from the plugin config row, or return null if S3 is not configured.
 */
export function createS3StorageFromConfig(config: Record<string, any>): S3ModelStorage | null {
  if (config?.storageMode !== 's3') return null;
  if (!config.s3Bucket || !config.s3Region || !config.s3AccessKeyId || !config.s3SecretAccessKey) {
    return null;
  }
  return new S3ModelStorage({
    bucket: config.s3Bucket,
    region: config.s3Region,
    endpoint: config.s3Endpoint || undefined,
    accessKeyId: config.s3AccessKeyId,
    secretAccessKey: config.s3SecretAccessKey,
    keyPrefix: config.s3KeyPrefix || 'embed-web-client',
  });
}

function normalizeStorageId(id: any): number | string | undefined {
  if (id == null || id === '') return undefined;
  if (typeof id === 'number') return id;
  if (typeof id === 'string' && /^[1-9]\d*$/.test(id)) {
    const bigIntVal = BigInt(id);
    if (bigIntVal <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(id);
  }
  return String(id);
}

function getPluginSafely(app: any, name: string): any {
  try {
    return app.pm?.get?.(name);
  } catch {
    return null;
  }
}

/**
 * Build S3 model storage from the File Manager storage selected in plugin config.
 * Falls back to legacy inline S3 fields for existing installations.
 */
export async function createS3StorageFromConfigWithFileManager(
  config: Record<string, any>,
  app?: any,
): Promise<S3ModelStorage | null> {
  if (config?.storageMode !== 's3') return null;

  const storageId = normalizeStorageId(config.s3StorageId);
  if (storageId != null && app) {
    const fileManager =
      getPluginSafely(app, '@nocobase/plugin-file-manager') ||
      getPluginSafely(app, 'file-manager') ||
      getPluginSafely(app, 'plugin-file-manager');

    if (fileManager && !fileManager.storagesCache?.size && fileManager.loadStorages) {
      await fileManager.loadStorages();
    }

    const storage =
      fileManager?.storagesCache?.get(storageId) ||
      Array.from(fileManager?.storagesCache?.values?.() ?? []).find(
        (item: any) => String(item.id) === String(storageId),
      );

    if (!storage) {
      throw new Error(`File Manager storage "${config.s3StorageId}" was not found`);
    }
    if (!['s3', 's3-private'].includes(storage.type)) {
      throw new Error(`File Manager storage "${storage.name}" is not an S3 storage`);
    }

    const options = storage.options ?? {};
    if (!options.bucket || !options.region || !options.accessKeyId || !options.secretAccessKey) {
      throw new Error(`File Manager S3 storage "${storage.name}" is missing bucket, region, or credentials`);
    }

    return new S3ModelStorage({
      bucket: options.bucket,
      region: options.region,
      endpoint: options.endpoint || undefined,
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      keyPrefix: config.s3KeyPrefix || 'embed-web-client',
    });
  }

  return createS3StorageFromConfig(config);
}

/** Returns the MIME type for a model file extension. */
export function modelFileMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext === 'json') return 'application/json';
  if (ext === 'txt') return 'text/plain';
  return 'application/octet-stream';
}
