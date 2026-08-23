/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type SftpClient from 'ssh2-sftp-client';
import { Readable } from 'stream';
import { sftpPoolManager } from './sftp-pool-manager';
import type { RangeOptions } from './adapters/types';

export interface SftpConfig {
  id: number | string;
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'privateKey';
  password?: string;
  privateKey?: string;
  passphrase?: string;
  basePath?: string;
  poolMax?: number;
  poolMin?: number;
  idleTimeoutMillis?: number;
  acquireTimeoutMillis?: number;
  readyTimeout?: number;
}

export interface SftpFileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'link';
  size: number;
  modifyTime: number;
  accessTime: number;
  rights: {
    user: string;
    group: string;
    other: string;
  };
  owner: number;
  group: number;
}

export interface SftpFileStat {
  mode: number;
  uid: number;
  gid: number;
  size: number;
  accessTime: number;
  modifyTime: number;
  isDirectory: boolean;
  isFile: boolean;
  isBlockDevice: boolean;
  isCharacterDevice: boolean;
  isSymbolicLink: boolean;
  isFIFO: boolean;
  isSocket: boolean;
}

/**
 * Manages a pool of SFTP connections keyed by config ID.
 * Handles reconnection, cleanup, and provides a unified API for SFTP operations.
 */
export class SftpConnectionManager {
  private configs = new Map<string | number, SftpConfig>();
  private logger: any;

  constructor(logger?: any) {
    this.logger = logger || console;
  }

  registerConfig(config: SftpConfig) {
    this.configs.set(config.id, config);
  }

  async unregisterConfig(configId: string | number) {
    const config = this.findConfig(configId);
    if (config) {
      this.configs.delete(config.id);
      await sftpPoolManager.closePool(config);
    }
  }

  private findConfig(configId: string | number): SftpConfig | undefined {
    if (configId === undefined || configId === null) {
      return undefined;
    }
    let config = this.configs.get(configId);
    if (!config) {
      const strId = String(configId);
      config = this.configs.get(strId);
      if (!config) {
        const numId = Number(configId);
        if (!isNaN(numId)) {
          config = this.configs.get(numId);
        }
      }
      if (!config) {
        for (const [k, v] of this.configs.entries()) {
          if (String(k) === strId) {
            config = v;
            break;
          }
        }
      }
    }
    return config;
  }

  private getConfigOptions(configId: string | number) {
    const config = this.findConfig(configId);
    if (!config) {
      throw new Error(`[sftp-private] No config found for ID: ${configId}`);
    }
    return config;
  }

  async testConnection(config: Omit<SftpConfig, 'id'>): Promise<{ success: boolean; message: string; cwd?: string }> {
    let clientData: Awaited<ReturnType<typeof sftpPoolManager.acquire>> | null = null;
    try {
      clientData = await sftpPoolManager.acquire(config as any);
      const cwd = await clientData.client.cwd();
      return { success: true, message: 'Connection successful', cwd };
    } catch (error: any) {
      if (clientData) {
        await clientData.destroy();
        clientData = null;
      }
      return { success: false, message: error.message || 'Connection failed' };
    } finally {
      if (clientData) {
        clientData.release();
      }
    }
  }

  /**
   * List files in a directory
   */
  async listFiles(configId: string | number, remotePath: string): Promise<SftpFileEntry[]> {
    const { client, release } = await sftpPoolManager.acquire(this.getConfigOptions(configId));
    try {
      const rawList = await client.list(remotePath);
      return rawList
        .filter((item) => item.name !== '.' && item.name !== '..')
        .map((item) => ({
          name: item.name,
          path: remotePath.replace(/\/$/, '') + '/' + item.name,
          type: item.type === 'd' ? ('directory' as const) : item.type === 'l' ? ('link' as const) : ('file' as const),
          size: item.size,
          modifyTime: item.modifyTime,
          accessTime: item.accessTime,
          rights: item.rights,
          owner: item.owner,
          group: item.group,
        }));
    } finally {
      release();
    }
  }

  /**
   * Get file stats
   */
  async stat(configId: string | number, remotePath: string): Promise<SftpFileStat> {
    const { client, release } = await sftpPoolManager.acquire(this.getConfigOptions(configId));
    try {
      const stats = await client.stat(remotePath);
      return stats as unknown as SftpFileStat;
    } finally {
      release();
    }
  }

  async exists(configId: string | number, remotePath: string): Promise<false | 'd' | '-' | 'l'> {
    const { client, release } = await sftpPoolManager.acquire(this.getConfigOptions(configId));
    try {
      return await client.exists(remotePath);
    } finally {
      release();
    }
  }

  /**
   * Get a readable stream for a remote file.
   * When `range` is provided only the requested byte window is streamed
   * (inclusive bounds), enabling HTTP Range / media seeking support.
   */
  async getFileStream(configId: string | number, remotePath: string, range?: RangeOptions): Promise<Readable> {
    const { client, release, destroy } = await sftpPoolManager.acquire(this.getConfigOptions(configId));
    const sftp = (client as any).sftp;
    if (!sftp) {
      await destroy();
      throw new Error('SFTP stream API is unavailable; refusing to buffer remote file in memory');
    }

    return new Promise<Readable>((resolve, reject) => {
      try {
        const readOptions: Record<string, unknown> = {};
        if (range) {
          readOptions.start = range.start;
          if (range.end !== undefined) {
            readOptions.end = range.end;
          }
        }
        const readStream = sftp.createReadStream(remotePath, readOptions);
        let released = false;
        const cleanup = () => {
          if (!released) {
            released = true;
            release();
          }
        };
        const cleanupError = () => {
          if (!released) {
            released = true;
            destroy().catch(() => {});
          }
        };
        readStream.once('close', cleanup);
        readStream.once('end', cleanup);
        readStream.once('error', cleanupError);
        resolve(readStream);
      } catch (err) {
        destroy().catch(() => {});
        reject(err);
      }
    });
  }

  /**
   * Upload a file from a readable stream
   */
  async putFileStream(configId: string | number, remotePath: string, stream: Readable): Promise<void> {
    const { client, release } = await sftpPoolManager.acquire(this.getConfigOptions(configId));
    try {
      await client.put(stream, remotePath);
    } finally {
      release();
    }
  }

  async mkdir(configId: string | number, remotePath: string): Promise<void> {
    const { client, release } = await sftpPoolManager.acquire(this.getConfigOptions(configId));
    try {
      await client.mkdir(remotePath, true);
    } finally {
      release();
    }
  }

  async deleteFile(configId: string | number, remotePath: string): Promise<void> {
    const { client, release } = await sftpPoolManager.acquire(this.getConfigOptions(configId));
    try {
      await client.delete(remotePath);
    } finally {
      release();
    }
  }

  async deleteDir(configId: string | number, remotePath: string): Promise<void> {
    const { client, release } = await sftpPoolManager.acquire(this.getConfigOptions(configId));
    try {
      await client.rmdir(remotePath, true);
    } finally {
      release();
    }
  }

  async rename(configId: string | number, oldPath: string, newPath: string): Promise<void> {
    const { client, release } = await sftpPoolManager.acquire(this.getConfigOptions(configId));
    try {
      await client.rename(oldPath, newPath);
    } finally {
      release();
    }
  }

  /**
   * Disconnect a specific connection
   */
  async disconnect(configId: string | number): Promise<void> {
    // Left empty for compatibility, pooling handles this
  }

  async destroy(): Promise<void> {
    await sftpPoolManager.closeAll();
    this.configs.clear();
  }
}

export default SftpConnectionManager;
