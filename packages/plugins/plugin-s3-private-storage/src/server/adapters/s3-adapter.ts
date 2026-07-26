/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Readable } from 'stream';
import path from 'path';
import type { ListObjectsV2CommandOutput } from '@aws-sdk/client-s3';
import { IStorageAdapter, FileEntry, PutStreamOptions, ListOptions, ListResult } from './types';

/**
 * S3 storage adapter implementing IStorageAdapter.
 * Uses SDK classes provided by plugin-s3-private-storage at runtime
 * to avoid bundling a separate copy of the ~8MB AWS SDK.
 *
 * All S3 SDK types/classes are injected via the constructor.
 */
export class S3Adapter implements IStorageAdapter {
  private client: any; // S3Client
  private bucket: string;
  private sdk: any; // SDK classes from s3 plugin

  constructor(params: { client: any; bucket: string; sdk: any }) {
    this.client = params.client;
    this.bucket = params.bucket;
    this.sdk = params.sdk;
  }

  private normalizePrefix(remotePath: string): string {
    let prefix = remotePath.replace(/^\/+/, '');
    if (prefix && !prefix.endsWith('/')) {
      prefix += '/';
    }
    return prefix;
  }

  private guessMime(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.txt': 'text/plain',
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.xml': 'application/xml',
      '.pdf': 'application/pdf',
      '.zip': 'application/zip',
      '.gz': 'application/gzip',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp',
      '.mp4': 'video/mp4',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.ppt': 'application/vnd.ms-powerpoint',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.csv': 'text/csv',
      '.md': 'text/markdown',
    };
    return mimeMap[ext] || 'application/octet-stream';
  }

  private toFileEntries(response: ListObjectsV2CommandOutput, prefix: string): FileEntry[] {
    const entries: FileEntry[] = [];

    for (const commonPrefix of response.CommonPrefixes || []) {
      if (!commonPrefix.Prefix) continue;

      const name = commonPrefix.Prefix.replace(prefix, '').replace(/\/$/, '');
      if (name) {
        entries.push({
          name,
          path: '/' + commonPrefix.Prefix.replace(/\/$/, ''),
          type: 'directory',
          size: 0,
          modifiedAt: 0,
        });
      }
    }

    for (const object of response.Contents || []) {
      if (!object.Key || object.Key === prefix) continue;

      const name = object.Key.replace(prefix, '');
      if (!name.includes('/')) {
        entries.push({
          name,
          path: '/' + object.Key,
          type: 'file',
          size: object.Size || 0,
          modifiedAt: object.LastModified ? object.LastModified.getTime() : 0,
          mimetype: this.guessMime(name),
        });
      }
    }

    return entries;
  }

  async list(remotePath: string, options?: ListOptions): Promise<FileEntry[] | ListResult> {
    const { ListObjectsV2Command } = this.sdk;
    const prefix = this.normalizePrefix(remotePath);
    const entries: FileEntry[] = [];

    // Fallback to recursive retrieval if search query is provided to ensure global search coverage
    if (options?.search) {
      let continuationToken: string | undefined;
      do {
        const response = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: prefix,
            Delimiter: '/',
            MaxKeys: 1000,
            ContinuationToken: continuationToken,
          }),
        );

        if (response.CommonPrefixes) {
          for (const cp of response.CommonPrefixes) {
            if (cp.Prefix) {
              const name = cp.Prefix.replace(prefix, '').replace(/\/$/, '');
              if (name) {
                entries.push({
                  name,
                  path: '/' + cp.Prefix.replace(/\/$/, ''),
                  type: 'directory',
                  size: 0,
                  modifiedAt: 0,
                });
              }
            }
          }
        }

        if (response.Contents) {
          for (const obj of response.Contents) {
            if (obj.Key && obj.Key !== prefix) {
              const name = obj.Key.replace(prefix, '');
              if (!name.includes('/')) {
                entries.push({
                  name,
                  path: '/' + obj.Key,
                  type: 'file',
                  size: obj.Size || 0,
                  modifiedAt: obj.LastModified ? obj.LastModified.getTime() : 0,
                  mimetype: this.guessMime(name),
                });
              }
            }
          }
        }

        continuationToken = response.NextContinuationToken;
      } while (continuationToken);

      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      return entries;
    }

    const limit = options?.limit || 100;
    let remainingOffset = options?.offset || 0;
    let continuationToken = options?.continuationToken;

    // S3 accepts cursors rather than offsets. Consume only the exact number of
    // visible entries requested so the final response can expose a valid cursor.
    while (remainingOffset > 0) {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          Delimiter: '/',
          MaxKeys: Math.min(remainingOffset, 1000),
          ContinuationToken: continuationToken,
        }),
      );
      remainingOffset -= this.toFileEntries(response, prefix).length;
      continuationToken = response.NextContinuationToken;

      if (!continuationToken) {
        return { entries: [], hasMore: false };
      }
    }

    let hasMore = false;
    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          Delimiter: '/',
          MaxKeys: limit - entries.length,
          ContinuationToken: continuationToken,
        }),
      );
      entries.push(...this.toFileEntries(response, prefix));
      continuationToken = response.NextContinuationToken;
      hasMore = response.IsTruncated || false;
    } while (entries.length < limit && continuationToken);

    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return {
      entries,
      nextContinuationToken: continuationToken,
      hasMore,
    };
  }

  async stat(remotePath: string): Promise<FileEntry> {
    const { HeadObjectCommand, ListObjectsV2Command } = this.sdk;
    const key = remotePath.replace(/^\/+/, '');

    try {
      const response = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      return {
        name: path.basename(key),
        path: '/' + key,
        type: 'file',
        size: response.ContentLength || 0,
        modifiedAt: response.LastModified ? response.LastModified.getTime() : 0,
        mimetype: response.ContentType || this.guessMime(key),
      };
    } catch (error: any) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        const prefix = key.endsWith('/') ? key : key + '/';
        const listResponse = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: prefix,
            MaxKeys: 1,
          }),
        );
        if ((listResponse.Contents?.length || 0) > 0) {
          return { name: path.basename(key), path: '/' + key, type: 'directory', size: 0, modifiedAt: 0 };
        }
        throw new Error(`Path not found: ${remotePath}`);
      }
      throw error;
    }
  }

  async getStream(remotePath: string): Promise<{ stream: Readable; contentType?: string; size?: number }> {
    const { GetObjectCommand } = this.sdk;
    const key = remotePath.replace(/^\/+/, '');
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!response.Body) throw new Error(`Failed to get stream for: ${remotePath}`);
    return {
      stream: response.Body as unknown as Readable,
      contentType: response.ContentType || this.guessMime(key),
      size: response.ContentLength,
    };
  }

  async putStream(remotePath: string, stream: Readable, options?: PutStreamOptions): Promise<void> {
    const { Upload } = this.sdk;
    const key = remotePath.replace(/^\/+/, '');
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: stream,
        ContentType: options?.mimetype || this.guessMime(key),
      },
      queueSize: 1,
      leavePartsOnError: false,
    });
    await upload.done();
  }

  async mkdir(remotePath: string): Promise<void> {
    const { PutObjectCommand } = this.sdk;
    let key = remotePath.replace(/^\/+/, '');
    if (!key.endsWith('/')) key += '/';
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: '',
        ContentType: 'application/x-directory',
      }),
    );
  }

  async delete(remotePath: string): Promise<void> {
    const { DeleteObjectCommand } = this.sdk;
    const key = remotePath.replace(/^\/+/, '');
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async deleteDir(remotePath: string): Promise<void> {
    const { ListObjectsV2Command, DeleteObjectsCommand } = this.sdk;
    let prefix = remotePath.replace(/^\/+/, '');
    if (!prefix.endsWith('/')) prefix += '/';

    const objects: { Key: string }[] = [];
    let continuationToken: string | undefined;

    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          MaxKeys: 1000,
          ContinuationToken: continuationToken,
        }),
      );
      if (response.Contents) {
        for (const obj of response.Contents) {
          if (obj.Key) objects.push({ Key: obj.Key });
        }
      }
      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    if (objects.length === 0) return;

    for (let i = 0; i < objects.length; i += 1000) {
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: objects.slice(i, i + 1000), Quiet: true },
        }),
      );
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const { CopyObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = this.sdk;
    const oldKey = oldPath.replace(/^\/+/, '');
    const newKey = newPath.replace(/^\/+/, '');

    const stat = await this.stat(oldPath);
    if (stat.type === 'directory') {
      const oldPrefix = oldKey.endsWith('/') ? oldKey : `${oldKey}/`;
      const newPrefix = newKey.endsWith('/') ? newKey : `${newKey}/`;
      const copiedObjects: { Key: string }[] = [];
      let continuationToken: string | undefined;

      do {
        const response = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: oldPrefix,
            MaxKeys: 1000,
            ContinuationToken: continuationToken,
          }),
        );

        for (const obj of response.Contents || []) {
          if (!obj.Key) continue;
          const targetKey = `${newPrefix}${obj.Key.slice(oldPrefix.length)}`;
          await this.client.send(
            new CopyObjectCommand({
              Bucket: this.bucket,
              CopySource: encodeURIComponent(`${this.bucket}/${obj.Key}`),
              Key: targetKey,
            }),
          );
          copiedObjects.push({ Key: obj.Key });
        }

        continuationToken = response.NextContinuationToken;
      } while (continuationToken);

      for (let i = 0; i < copiedObjects.length; i += 1000) {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: copiedObjects.slice(i, i + 1000), Quiet: true },
          }),
        );
      }
      return;
    }

    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: encodeURIComponent(`${this.bucket}/${oldKey}`),
        Key: newKey,
      }),
    );
    await this.delete(oldPath);
  }

  async exists(remotePath: string): Promise<boolean> {
    try {
      await this.stat(remotePath);
      return true;
    } catch {
      return false;
    }
  }
}

export default S3Adapter;
