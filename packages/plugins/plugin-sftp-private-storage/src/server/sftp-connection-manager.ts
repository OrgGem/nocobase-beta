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
  private connections = new Map<string | number, SftpClient>();
  private configs = new Map<string | number, SftpConfig>();
  private connecting = new Map<string | number, Promise<SftpClient>>();
  private logger: any;

  constructor(logger?: any) {
    this.logger = logger || console;
  }

  /**
   * Register an SFTP config for connection management
   */
  registerConfig(config: SftpConfig) {
    this.configs.set(config.id, config);
  }

  /**
   * Remove a config and close its connection
   */
  async unregisterConfig(configId: string | number) {
    await this.disconnect(configId);
    this.configs.delete(configId);
  }

  /**
   * Get or create an SFTP connection for the given config ID
   */
  async getConnection(configId: string | number): Promise<SftpClient> {
    // Return existing healthy connection
    const existing = this.connections.get(configId);
    if (existing) {
      try {
        // Quick health check - try to get cwd
        await existing.cwd();
        return existing;
      } catch {
        // Connection is dead, clean up and reconnect
        this.connections.delete(configId);
        try { existing.end(); } catch { /* ignore */ }
      }
    }

    // If already connecting, wait for it
    const pendingConnect = this.connecting.get(configId);
    if (pendingConnect) {
      return pendingConnect;
    }

    // Create new connection
    const connectPromise = this.connect(configId);
    this.connecting.set(configId, connectPromise);

    try {
      const client = await connectPromise;
      return client;
    } finally {
      this.connecting.delete(configId);
    }
  }

  private async connect(configId: string | number): Promise<SftpClient> {
    const config = this.configs.get(configId);
    if (!config) {
      throw new Error(`[sftp-private] No config found for ID: ${configId}`);
    }

    const client = new SftpClient();

    const connectOptions: any = {
      host: config.host,
      port: config.port || 22,
      username: config.username,
      readyTimeout: 15000,
      retries: 2,
      retry_factor: 2,
      retry_minTimeout: 2000,
    };

    if (config.authMethod === 'privateKey' && config.privateKey) {
      connectOptions.privateKey = config.privateKey;
      if (config.passphrase) {
        connectOptions.passphrase = config.passphrase;
      }
    } else if (config.password) {
      connectOptions.password = config.password;
    }

    try {
      await client.connect(connectOptions);
      this.connections.set(configId, client);
      this.logger.info?.(`[sftp-private] Connected to ${config.host}:${config.port}`);
      return client;
    } catch (error) {
      this.logger.error?.(`[sftp-private] Failed to connect to ${config.host}:${config.port}`, error);
      throw error;
    }
  }

  /**
   * Test connection to an SFTP server using the given config
   */
  async testConnection(config: Omit<SftpConfig, 'id'>): Promise<{ success: boolean; message: string; cwd?: string }> {
    const client = new SftpClient();
    try {
      const connectOptions: any = {
        host: config.host,
        port: config.port || 22,
        username: config.username,
        readyTimeout: 10000,
      };

      if (config.authMethod === 'privateKey' && config.privateKey) {
        connectOptions.privateKey = config.privateKey;
        if (config.passphrase) {
          connectOptions.passphrase = config.passphrase;
        }
      } else if (config.password) {
        connectOptions.password = config.password;
      }

      await client.connect(connectOptions);
      const cwd = await client.cwd();
      await client.end();

      return { success: true, message: 'Connection successful', cwd };
    } catch (error: any) {
      try { await client.end(); } catch { /* ignore */ }
      return { success: false, message: error.message || 'Connection failed' };
    }
  }

  /**
   * List files in a directory
   */
  async listFiles(configId: string | number, remotePath: string): Promise<SftpFileEntry[]> {
    const client = await this.getConnection(configId);
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
  }

  /**
   * Get file stats
   */
  async stat(configId: string | number, remotePath: string): Promise<SftpFileStat> {
    const client = await this.getConnection(configId);
    const stats = await client.stat(remotePath);
    return stats as unknown as SftpFileStat;
  }

  /**
   * Check if a path exists
   */
  async exists(configId: string | number, remotePath: string): Promise<false | 'd' | '-' | 'l'> {
    const client = await this.getConnection(configId);
    return client.exists(remotePath);
  }

  /**
   * Get a readable stream for a remote file
   */
  async getFileStream(configId: string | number, remotePath: string): Promise<Readable> {
    const client = await this.getConnection(configId);
    // ssh2-sftp-client's get with a dst of undefined returns a buffer
    // We need to use createReadStream for streaming
    const sftp = (client as any).sftp;
    if (!sftp) {
      // Fallback: get as buffer and convert to stream
      const buffer = await client.get(remotePath) as Buffer;
      const stream = new Readable();
      stream.push(buffer);
      stream.push(null);
      return stream;
    }

    return new Promise<Readable>((resolve, reject) => {
      try {
        const readStream = sftp.createReadStream(remotePath);
        readStream.on('error', reject);
        // Wait for 'ready' or resolve immediately
        resolve(readStream);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Upload a file from a readable stream
   */
  async putFileStream(configId: string | number, remotePath: string, stream: Readable): Promise<void> {
    const client = await this.getConnection(configId);
    await client.put(stream, remotePath);
  }

  /**
   * Create a directory (recursive)
   */
  async mkdir(configId: string | number, remotePath: string): Promise<void> {
    const client = await this.getConnection(configId);
    await client.mkdir(remotePath, true);
  }

  /**
   * Delete a file
   */
  async deleteFile(configId: string | number, remotePath: string): Promise<void> {
    const client = await this.getConnection(configId);
    await client.delete(remotePath);
  }

  /**
   * Delete a directory (recursive)
   */
  async deleteDir(configId: string | number, remotePath: string): Promise<void> {
    const client = await this.getConnection(configId);
    await client.rmdir(remotePath, true);
  }

  /**
   * Rename/move a file or directory
   */
  async rename(configId: string | number, oldPath: string, newPath: string): Promise<void> {
    const client = await this.getConnection(configId);
    await client.rename(oldPath, newPath);
  }

  /**
   * Disconnect a specific connection
   */
  async disconnect(configId: string | number): Promise<void> {
    const client = this.connections.get(configId);
    if (client) {
      try {
        await client.end();
      } catch (error) {
        this.logger.warn?.(`[sftp-private] Error disconnecting ${configId}:`, error);
      }
      this.connections.delete(configId);
    }
  }

  /**
   * Disconnect all connections and cleanup
   */
  async destroy(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [id] of this.connections) {
      promises.push(this.disconnect(id));
    }
    await Promise.allSettled(promises);
    this.connections.clear();
    this.configs.clear();
    this.connecting.clear();
  }
}

export default SftpConnectionManager;
