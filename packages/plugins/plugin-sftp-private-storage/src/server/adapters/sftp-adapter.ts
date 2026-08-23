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
import {
  IStorageAdapter,
  FileEntry,
  PutStreamOptions,
  ListOptions,
  ListResult,
  RangeOptions,
  GetStreamResult,
} from './types';

// Use inline type instead of cross-plugin import.
// The actual SftpConnectionManager is injected at runtime from plugin-sftp-private-storage.
interface SftpConnectionManager {
  listFiles(configId: string | number, remotePath: string): Promise<any[]>;
  stat(configId: string | number, remotePath: string): Promise<any>;
  exists(configId: string | number, remotePath: string): Promise<false | 'd' | '-' | 'l'>;
  getFileStream(configId: string | number, remotePath: string, range?: RangeOptions): Promise<Readable>;
  putFileStream(configId: string | number, remotePath: string, stream: Readable): Promise<void>;
  mkdir(configId: string | number, remotePath: string): Promise<void>;
  deleteFile(configId: string | number, remotePath: string): Promise<void>;
  deleteDir(configId: string | number, remotePath: string): Promise<void>;
  rename(configId: string | number, oldPath: string, newPath: string): Promise<void>;
}

/**
 * SFTP storage adapter implementing IStorageAdapter.
 * Wraps the SftpConnectionManager from plugin-sftp-private-storage.
 */
export class SftpAdapter implements IStorageAdapter {
  private connectionManager: SftpConnectionManager;
  private configId: string | number;
  private basePath: string;

  constructor(connectionManager: SftpConnectionManager, configId: string | number, basePath = '/') {
    this.connectionManager = connectionManager;
    this.configId = configId;
    this.basePath = this.normalizePath(basePath || '/');
  }

  private normalizePath(value: string): string {
    const normalized = value.replace(/\\/g, '/').replace(/\/+/g, '/');
    if (!normalized || normalized === '.') {
      return '/';
    }
    return normalized.startsWith('/') ? normalized : '/' + normalized;
  }

  private assertSafePath(value: string): void {
    const parts = this.normalizePath(value || '/')
      .split('/')
      .filter(Boolean);
    if (parts.some((part) => part === '..' || part === '.')) {
      const error = new Error('Access denied');
      (error as NodeJS.ErrnoException).code = 'PATH_TRAVERSAL';
      throw error;
    }
  }

  private resolveStoragePath(remotePath: string): string {
    this.assertSafePath(remotePath || '/');
    const normalizedRemote = this.normalizePath(remotePath || '/');
    const normalizedBase = this.normalizePath(this.basePath || '/');
    const resolved =
      normalizedBase === '/'
        ? normalizedRemote
        : normalizedRemote === '/'
          ? normalizedBase
          : `${normalizedBase.replace(/\/+$/, '')}${normalizedRemote}`;

    if (
      normalizedBase !== '/' &&
      resolved !== normalizedBase &&
      !resolved.startsWith(`${normalizedBase.replace(/\/+$/, '')}/`)
    ) {
      const error = new Error('Access denied');
      (error as NodeJS.ErrnoException).code = 'PATH_TRAVERSAL';
      throw error;
    }

    return resolved;
  }

  private toAdapterPath(storagePath: string): string {
    const normalizedStoragePath = this.normalizePath(storagePath || '/');
    if (this.basePath === '/') {
      return normalizedStoragePath;
    }
    if (normalizedStoragePath === this.basePath) {
      return '/';
    }
    if (normalizedStoragePath.startsWith(this.basePath.replace(/\/+$/, '') + '/')) {
      return normalizedStoragePath.slice(this.basePath.replace(/\/+$/, '').length) || '/';
    }
    return normalizedStoragePath;
  }

  private guessMime(filename: string): string | undefined {
    const ext = path.extname(filename).toLowerCase();
    const map: Record<string, string> = {
      '.txt': 'text/plain',
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.pdf': 'application/pdf',
      '.zip': 'application/zip',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp',
      '.mp4': 'video/mp4',
      '.mp3': 'audio/mpeg',
      '.doc': 'application/msword',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.csv': 'text/csv',
      '.md': 'text/markdown',
    };
    return map[ext];
  }

  async list(remotePath: string, options?: ListOptions): Promise<FileEntry[] | ListResult> {
    const normalizedPath = this.resolveStoragePath(remotePath || '/');
    const rawEntries = await this.connectionManager.listFiles(this.configId, normalizedPath);

    let entries: FileEntry[] = rawEntries.map((entry) => ({
      name: entry.name,
      path: this.toAdapterPath(entry.path),
      type: entry.type === 'directory' || entry.type === 'link' ? ('directory' as const) : ('file' as const),
      size: entry.size || 0,
      modifiedAt: entry.modifyTime || 0,
      mimetype: entry.type === 'file' ? this.guessMime(entry.name) : undefined,
    }));

    // Apply filtering if options are provided
    if (options?.type) {
      entries = entries.filter((entry) => entry.type === options.type);
    }
    if (options?.search) {
      const searchLower = options.search.toLowerCase();
      entries = entries.filter((entry) => entry.name.toLowerCase().includes(searchLower));
    }

    // Sort: directories first, then files, alphabetically within each group
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    // If pagination options are specified, slice and return ListResult
    if (options && (options.limit !== undefined || options.offset !== undefined)) {
      const limit = options.limit || 100;
      const offset = options.offset || 0;
      const sliced = entries.slice(offset, offset + limit);

      return {
        entries: sliced,
        total: entries.length,
        hasMore: offset + limit < entries.length,
      };
    }

    return entries;
  }

  async stat(remotePath: string): Promise<FileEntry> {
    const storagePath = this.resolveStoragePath(remotePath);
    const stats = await this.connectionManager.stat(this.configId, storagePath);
    const name = path.basename(remotePath);

    return {
      name,
      path: remotePath,
      type: stats.isDirectory ? 'directory' : 'file',
      size: stats.size || 0,
      modifiedAt: stats.modifyTime || 0,
      mimetype: stats.isFile ? this.guessMime(name) : undefined,
    };
  }

  async getStream(remotePath: string, range?: RangeOptions): Promise<GetStreamResult> {
    const storagePath = this.resolveStoragePath(remotePath);
    const stats = await this.connectionManager.stat(this.configId, storagePath);
    const name = path.basename(remotePath);

    if (range) {
      const total = Math.max(0, stats.size || 0);
      const unsatisfiable = () => {
        const error = new Error('Requested range not satisfiable') as Error & { status?: number; code?: string };
        error.status = 416;
        error.code = 'RANGE_NOT_SATISFIABLE';
        return error;
      };

      // plugin-external-storage-manager rejects unsatisfiable ranges before
      // calling getStream, but validate defensively here too.
      if (!Number.isInteger(range.start) || range.start < 0) {
        throw unsatisfiable();
      }
      if (total === 0 || range.start >= total) {
        throw unsatisfiable();
      }
      if (range.end !== undefined && (!Number.isInteger(range.end) || range.end < range.start)) {
        throw unsatisfiable();
      }

      const end = Math.min(range.end ?? total - 1, total - 1);
      const effectiveRange: RangeOptions = { start: range.start, end };
      const stream = await this.connectionManager.getFileStream(this.configId, storagePath, effectiveRange);
      return {
        stream,
        contentType: this.guessMime(name) || 'application/octet-stream',
        size: end - range.start + 1,
        contentRange: `bytes ${range.start}-${end}/${total}`,
      };
    }

    const stream = await this.connectionManager.getFileStream(this.configId, storagePath);
    return {
      stream,
      contentType: this.guessMime(name) || 'application/octet-stream',
      size: stats.size,
    };
  }

  async putStream(remotePath: string, stream: Readable, options?: PutStreamOptions): Promise<void> {
    const storagePath = this.resolveStoragePath(remotePath);
    // Ensure parent directory exists
    const parentDir = path.posix.dirname(storagePath);
    const exists = await this.connectionManager.exists(this.configId, parentDir);
    if (!exists) {
      await this.connectionManager.mkdir(this.configId, parentDir);
    }

    await this.connectionManager.putFileStream(this.configId, storagePath, stream);
  }

  async mkdir(remotePath: string): Promise<void> {
    await this.connectionManager.mkdir(this.configId, this.resolveStoragePath(remotePath));
  }

  async delete(remotePath: string): Promise<void> {
    await this.connectionManager.deleteFile(this.configId, this.resolveStoragePath(remotePath));
  }

  async deleteDir(remotePath: string): Promise<void> {
    await this.connectionManager.deleteDir(this.configId, this.resolveStoragePath(remotePath));
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.connectionManager.rename(
      this.configId,
      this.resolveStoragePath(oldPath),
      this.resolveStoragePath(newPath),
    );
  }

  async exists(remotePath: string): Promise<boolean> {
    const result = await this.connectionManager.exists(this.configId, this.resolveStoragePath(remotePath));
    return result !== false;
  }
}

export default SftpAdapter;
