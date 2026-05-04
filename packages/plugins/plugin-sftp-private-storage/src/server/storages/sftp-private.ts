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
import SftpClient from 'ssh2-sftp-client';
import { AttachmentModel, StorageModel, StorageType, cloudFilenameGetter } from '@nocobase/plugin-file-manager';
import { STORAGE_TYPE_SFTP_PRIVATE } from '../../constants';

class CountingStream extends Transform {
  size = 0;

  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback) {
    this.size += chunk.length;
    callback(null, chunk);
  }
}

export default class SftpPrivateStorage extends StorageType {
  static filenameKey = 'key';

  // @ts-ignore
  declare storage: StorageModel;
  // @ts-ignore
  declare getFileKey: (record: AttachmentModel) => string;

  static defaults() {
    return {
      title: 'SFTP (Private)',
      name: 'sftp-private',
      type: STORAGE_TYPE_SFTP_PRIVATE,
      baseUrl: '',
      options: {
        host: process.env.SFTP_STORAGE_HOST,
        port: Number(process.env.SFTP_STORAGE_PORT || 22),
        username: process.env.SFTP_STORAGE_USERNAME,
        password: process.env.SFTP_STORAGE_PASSWORD,
        privateKey: process.env.SFTP_STORAGE_PRIVATE_KEY,
        passphrase: process.env.SFTP_STORAGE_PASSPHRASE,
        authMethod: process.env.SFTP_STORAGE_AUTH_METHOD || 'password',
        basePath: process.env.SFTP_STORAGE_BASE_PATH || '/',
      },
    };
  }

  constructor(storage: StorageModel) {
    super(storage);
  }

  private getConnectOptions() {
    const {
      host,
      port = 22,
      username,
      authMethod = 'password',
      password,
      privateKey,
      passphrase,
      readyTimeout = 15000,
      retries = 2,
      retry_factor = 2,
      retry_minTimeout = 2000,
    } = this.storage.options || {};

    const connectOptions: any = {
      host,
      port: Number(port || 22),
      username,
      readyTimeout,
      retries,
      retry_factor,
      retry_minTimeout,
    };

    if (authMethod === 'privateKey' && privateKey) {
      connectOptions.privateKey = privateKey;
      if (passphrase) {
        connectOptions.passphrase = passphrase;
      }
    } else if (password) {
      connectOptions.password = password;
    }

    return connectOptions;
  }

  private async connect() {
    const client = new SftpClient();
    await client.connect(this.getConnectOptions());
    return client;
  }

  private resolveRemotePath(key: string) {
    const basePath = this.normalizeRemotePath(this.storage.options?.basePath || '/');
    const normalizedKey = this.normalizeRemotePath(key || '').replace(/^\/+/, '');
    const segments = normalizedKey.split('/').filter(Boolean);

    if (segments.some((segment) => segment === '..')) {
      const error = new Error('Access denied');
      (error as NodeJS.ErrnoException).code = 'PATH_TRAVERSAL';
      throw error;
    }

    if (!normalizedKey) {
      return basePath;
    }

    if (basePath === '/') {
      return `/${normalizedKey}`;
    }

    return `${basePath.replace(/\/+$/, '')}/${normalizedKey}`;
  }

  private normalizeRemotePath(value: string) {
    const normalized = String(value || '/')
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/');
    if (!normalized || normalized === '.') {
      return '/';
    }
    return normalized.startsWith('/') ? normalized : `/${normalized}`;
  }

  make() {
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

        let client: SftpClient | null = null;

        try {
          const remotePath = this.resolveRemotePath(key);
          const parentDir = path.posix.dirname(remotePath);
          client = await this.connect();

          if (parentDir && parentDir !== '.') {
            await client.mkdir(parentDir, true);
          }

          const counter = new CountingStream();
          const uploadStream = file.stream.pipe(counter);
          await client.put(uploadStream, remotePath);

          done(null, {
            size: counter.size,
            key,
            contentType: file.mimetype || 'application/octet-stream',
          });
        } catch (error) {
          done(error);
        } finally {
          await client?.end().catch(() => {});
        }
      },

      _removeFile: (req: any, file: any, cb: Function) => {
        (async () => {
          let client: SftpClient | null = null;
          try {
            client = await this.connect();
            await client.delete(this.resolveRemotePath(file.key));
            cb(null);
          } catch (err) {
            cb(err);
          } finally {
            await client?.end().catch(() => {});
          }
        })();
      },
    };
  }

  async delete(records: AttachmentModel[]): Promise<[number, AttachmentModel[]]> {
    const client = await this.connect();
    let count = 0;
    const undeleted = [];

    try {
      for (const record of records) {
        const key = this.getFileKey(record);
        try {
          await client.delete(this.resolveRemotePath(key));
          count += 1;
        } catch (error: any) {
          if (error?.code === 2 || /no such file/i.test(error?.message || '')) {
            count += 1;
          } else {
            undeleted.push(record);
          }
        }
      }
    } finally {
      await client.end().catch(() => {});
    }

    return [count, undeleted];
  }

  async getFileStream(file: AttachmentModel): Promise<{ stream: Readable; contentType?: string }> {
    const client = await this.connect();
    const remotePath = this.resolveRemotePath(this.getFileKey(file));
    const sftp = (client as any).sftp;

    if (!sftp) {
      try {
        const buffer = (await client.get(remotePath)) as Buffer;
        await client.end().catch(() => {});
        return {
          stream: Readable.from(buffer),
          contentType: file.mimetype,
        };
      } catch (error) {
        await client.end().catch(() => {});
        throw error;
      }
    }

    try {
      const stream = sftp.createReadStream(remotePath);
      const cleanup = () => client.end().catch(() => {});
      stream.once('close', cleanup);
      stream.once('error', cleanup);
      return {
        stream,
        contentType: file.mimetype,
      };
    } catch (error) {
      await client.end().catch(() => {});
      throw error;
    }
  }

  getFileURL(file: AttachmentModel, preview?: boolean) {
    const fileId = (file as any).id;
    if (!fileId) {
      return '';
    }
    const mode = preview ? 'inline' : 'attachment';
    const collectionName = file.constructor?.name === 'aiFiles' ? 'aiFiles' : ((file.constructor as any)?.collection?.name || 'attachments');
    return `/api/attachments:stream?filterByTk=${fileId}&mode=${mode}&collection=${collectionName}`;
  }
}
