/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import path from 'path';
import { Readable, Transform, TransformCallback } from 'stream';
import { StorageType, cloudFilenameGetter, type StorageModel } from '@nocobase/plugin-file-manager';
import type { S3Client as AwsS3Client } from '@aws-sdk/client-s3';
import { STORAGE_TYPE_S3_PRIVATE } from '../../constants';
import { getPrivateS3StreamUrl } from './get-file-url';

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

  client: AwsS3Client;

  constructor(storage: StorageModel) {
    super(storage);
    this.client = this.createS3Client();
  }

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
    return this.client;
  }

  private createS3Client() {
    let S3ClientClass: typeof import('@aws-sdk/client-s3').S3Client;
    try {
      S3ClientClass = require('@aws-sdk/client-s3').S3Client;
    } catch (e) {
      throw new Error('@aws-sdk/client-s3 module is not installed. Please run `npm install @aws-sdk/client-s3` first.');
    }

    const storageOptions = { ...this.storage.options };
    const { accessKeyId, secretAccessKey, region, endpoint } = storageOptions;
    delete storageOptions.accessKeyId;
    delete storageOptions.secretAccessKey;
    delete storageOptions.region;
    delete storageOptions.endpoint;
    delete storageOptions.bucket;
    delete storageOptions.acl;
    const clientConfig: ConstructorParameters<typeof S3ClientClass>[0] = {
      region,
      ...storageOptions,
      requestChecksumCalculation: 'WHEN_REQUIRED',
    };

    if (accessKeyId && secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId,
        secretAccessKey,
      };
    }

    if (endpoint) {
      clientConfig.endpoint = endpoint;
      clientConfig.forcePathStyle = true;
    }

    const client = new S3ClientClass(clientConfig);
    client.middlewareStack.remove('flexibleChecksumsMiddleware');
    client.middlewareStack.remove('flexibleChecksumsInputMiddleware');
    return client;
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

          let UploadClass;
          try {
            UploadClass = require('@aws-sdk/lib-storage').Upload;
          } catch (e) {
            throw new Error(
              '@aws-sdk/lib-storage module is not installed. Please run `npm install @aws-sdk/lib-storage` first.',
            );
          }

          const upload = new UploadClass({
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
            let DeleteObjectCommandClass;
            try {
              DeleteObjectCommandClass = require('@aws-sdk/client-s3').DeleteObjectCommand;
            } catch (e) {
              throw new Error(
                '@aws-sdk/client-s3 module is not installed. Please run `npm install @aws-sdk/client-s3` first.',
              );
            }
            await s3.send(
              new DeleteObjectCommandClass({
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
    const s3 = this.client;
    const bucket = this.storage.options.bucket;

    let DeleteObjectCommandClass;
    try {
      DeleteObjectCommandClass = require('@aws-sdk/client-s3').DeleteObjectCommand;
    } catch (e) {
      throw new Error('@aws-sdk/client-s3 module is not installed. Please run `npm install @aws-sdk/client-s3` first.');
    }

    const deleted = [];
    for (const record of records) {
      // @ts-ignore
      const key = this.getFileKey(record);
      const deleteCommand = new DeleteObjectCommandClass({
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
    const s3 = this.client;
    const key = this.getFileKey(file);

    let GetObjectCommandClass;
    try {
      GetObjectCommandClass = require('@aws-sdk/client-s3').GetObjectCommand;
    } catch (e) {
      throw new Error('@aws-sdk/client-s3 module is not installed. Please run `npm install @aws-sdk/client-s3` first.');
    }

    const command = new GetObjectCommandClass({
      Bucket: this.storage.options.bucket,
      Key: key,
    });

    const response = await s3.send(command);

    if (!response.Body) {
      throw new Error(`Failed to get file stream for: ${key}`);
    }

    return {
      stream: response.Body as unknown as Readable,
      contentType: response.ContentType,
    };
  }

  getFileKey(file) {
    const key = file?.key || file?.Key;
    if (typeof key === 'string' && key.trim()) {
      return key.replace(/^\/+/, '');
    }

    const filename = file?.filename || file?.name;
    if (typeof filename === 'string' && filename.trim()) {
      return path.posix.join(String(file?.path || '').replace(/^\/+|\/+$/g, ''), filename).replace(/^\/+/, '');
    }

    if (typeof file?.title === 'string' && file.title.trim() && typeof file?.extname === 'string' && file.extname) {
      return path.posix
        .join(String(file?.path || '').replace(/^\/+|\/+$/g, ''), `${file.title}${file.extname}`)
        .replace(/^\/+/, '');
    }

    if (typeof file?.url === 'string' && file.url.trim()) {
      try {
        return new URL(file.url).pathname.replace(/^\/+/, '');
      } catch (error) {
        return file.url.replace(/^\/+/, '');
      }
    }

    throw new Error('S3 object key not found on attachment');
  }

  /**
   * Override getFileURL to return proxy URL instead of S3 URL.
   * The proxy endpoint will handle ACL and streaming.
   */
  getFileURL(file, preview) {
    return getPrivateS3StreamUrl(file, preview);
  }
}
