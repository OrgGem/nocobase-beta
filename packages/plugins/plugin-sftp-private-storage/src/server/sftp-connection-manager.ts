/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import SftpClient from 'ssh2-sftp-client';
import { Readable } from 'stream';
import { sftpPoolManager } from './sftp-pool-manager';

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
    // With pooling, we can't easily destroy a specific pool by configId 
    // unless we resolve the options hash. For now, just remove from map.
    this.configs.delete(configId);
  }

  private getConfigOptions(configId: string | number) {
    const config = this.configs.get(configId);
    if (!config) {
      throw new Error(`[sftp-private] No config found for ID: ${configId}`);
    }
    return config;
  }

  async testConnection(config: Omit<SftpConfig, 'id'>): Promise<{ success: boolean; message: string; cwd?: string }> {
    try {
      const { client, release, pool } = await sftpPoolManager.acquire(config as any);
      const cwd = await client.cwd();
      release();
      return { success: true, message: 'Connection successful', cwd };
    } catch (error: any) {
      return { success: false, message: error.message || 'Connection failed' };
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
          type: item.type === 'd' ? 'directory' as const : item.type === 'l' ? 'link' as const : 'file' as const,
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
   * Get a readable stream for a remote file
   */
  async getFileStream(configId: string | number, remotePath: string): Promise<Readable> {
    const { client, release, pool } = await sftpPoolManager.acquire(this.getConfigOptions(configId));
    const sftp = (client as any).sftp;
    if (!sftp) {
      try {
        const buffer = await client.get(remotePath) as Buffer;
        release();
        const stream = new Readable();
        stream.push(buffer);
        stream.push(null);
        return stream;
      } catch (err) {
        pool.destroy(client).catch(() => {});
        throw err;
      }
    }

    return new Promise<Readable>((resolve, reject) => {
      try {
        const readStream = sftp.createReadStream(remotePath);
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
            pool.destroy(client).catch(() => {});
          }
        };
        readStream.once('close', cleanup);
        readStream.once('end', cleanup);
        readStream.once('error', cleanupError);
        resolve(readStream);
      } catch (err) {
        pool.destroy(client).catch(() => {});
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
