/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { S3Client, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import crypto from 'crypto';
import path from 'path';
import { Readable, Transform, TransformCallback } from 'stream';
import { StorageType, cloudFilenameGetter } from '@nocobase/plugin-file-manager';
import { STORAGE_TYPE_S3_PRIVATE } from '../../constants';

/**
 * Transform stream that counts bytes passing through.
 * Used to track the actual file size during S3 uploads.
 */
class CountingStream extends Transform {
  size = 0;

  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback) {
    this.size += chunk.length;
    callback(null, chunk);
  }
}

export default class S3PrivateStorage extends StorageType {
  static filenameKey = 'key';
  
  // @ts-ignore
  declare storage: any;
  // @ts-ignore
  declare getFileKey: any;

  static defaults() {
    return {
      title: 'AWS S3 (Private)',
      name: 'aws-s3-private',
      type: STORAGE_TYPE_S3_PRIVATE,
      baseUrl: '', // Not used for private storage since we use proxy
      options: {
        region: process.env.AWS_S3_REGION,
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        bucket: process.env.AWS_S3_BUCKET,
      },
    };
  }

  getS3Client() {
    const { accessKeyId, secretAccessKey, region, endpoint, ...otherOptions } = this.storage.options;
    const clientConfig: any = {
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
      ...otherOptions,
    };

    if (endpoint) {
      clientConfig.endpoint = endpoint;
      clientConfig.forcePathStyle = true;
    }

    return new S3Client(clientConfig);
  }

  /**
   * Create multer storage engine for S3 uploads.
   * Uses @aws-sdk/lib-storage Upload with CountingStream to properly track file size.
   */
  make() {
    const s3 = this.getS3Client();
    const { bucket, acl = 'private' } = this.storage.options;
    const keyGetter = cloudFilenameGetter(this.storage);

    const once = (fn: Function) => {
      let called = false;
      return (...args: any[]) => {
        if (called) return;
        called = true;
        fn(...args);
      };
    };

    return {
      _handleFile: async (req: any, file: any, cb: Function) => {
        const done = once(cb);
        let key: string;
        try {
          key = await new Promise<string>((resolve, reject) => {
            keyGetter(req, file, (err, value) => {
              if (err) {
                reject(err);
                return;
              }
              resolve(value);
            });
          });
        } catch (error) {
          done(error);
          return;
        }

        const contentType = file.mimetype || 'application/octet-stream';

        try {
          const counter = new CountingStream();
          const uploadStream = file.stream.pipe(counter);

          const upload = new Upload({
            client: s3,
            params: {
              Bucket: bucket,
              Key: key,
              ACL: acl,
              Body: uploadStream,
              ContentType: contentType,
            },
            queueSize: 1,
            leavePartsOnError: false,
          });

          upload
            .done()
            .then((result) => {
              done(null, {
                size: counter.size,
                bucket,
                key,
                acl,
                contentType,
                etag: result.ETag,
                versionId: result.VersionId,
              });
            })
            .catch((error) => {
              done(error);
            });
        } catch (error) {
          done(error);
        }
      },

      _removeFile: (req: any, file: any, cb: Function) => {
        (async () => {
          try {
            await s3.send(
              new DeleteObjectCommand({
                Bucket: bucket,
                Key: file.key,
              }),
            );
            cb(null);
          } catch (err) {
            cb(err);
          }
        })();
      },
    };
  }

  /**
   * Delete files from S3
   */
  async delete(records) {
    const s3 = this.getS3Client();
    const bucket = this.storage.options.bucket;

    const deleted = [];
    for (const record of records) {
      // @ts-ignore
      const key = this.getFileKey(record);
      const deleteCommand = new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
      });
      await s3.send(deleteCommand);
      deleted.push({ Key: key });
    }

    return [
      deleted.length,
      // @ts-ignore
      records.filter((record) => !deleted.find((item) => item.Key === this.getFileKey(record))),
    ] as [number, any[]];
  }

  /**
   * Get file stream directly from S3 using credentials
   * This bypasses public URLs and works with private buckets
   */
  async getFileStream(file) {
    const s3 = this.getS3Client();

    const command = new GetObjectCommand({
      Bucket: this.storage.options.bucket,
      // @ts-ignore
      Key: this.getFileKey(file),
    });

    const response = await s3.send(command);

    if (!response.Body) {
      // @ts-ignore
      throw new Error(`Failed to get file stream for: ${this.getFileKey(file)}`);
    }

    return {
      stream: response.Body as unknown as Readable,
      contentType: response.ContentType,
    };
  }

  /**
   * Override getFileURL to return proxy URL instead of S3 URL.
   * The proxy endpoint will handle ACL and streaming.
   */
  getFileURL(file, preview) {
    const fileId = (file as any).id;
    if (!fileId) {
      return '';
    }
    const collectionName = file.constructor?.collection?.name || 'attachments';
    const mode = preview ? 'inline' : 'attachment';
    return `/api/attachments:stream?filterByTk=${fileId}&mode=${mode}&collection=${collectionName}`;
  }
}
