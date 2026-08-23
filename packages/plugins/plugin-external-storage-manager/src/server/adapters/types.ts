/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Readable } from 'stream';

/**
 * Unified file entry representation for all storage backends
 */
export interface FileEntry {
  /** File or folder name */
  name: string;
  /** Full path relative to the directory root */
  path: string;
  /** Entry type */
  type: 'file' | 'directory';
  /** File size in bytes (0 for directories) */
  size: number;
  /** Last modified timestamp (ms since epoch) */
  modifiedAt: number;
  /** MIME type (files only, may be undefined) */
  mimetype?: string;
}

/**
 * Options for uploading a file stream
 */
export interface PutStreamOptions {
  /** File size in bytes (for progress tracking) */
  size?: number;
  /** MIME type */
  mimetype?: string;
}

export interface ListOptions {
  limit?: number;
  offset?: number;
  continuationToken?: string;
  search?: string;
  type?: 'file' | 'directory';
}

/**
 * Byte-range options for partial downloads (HTTP Range support).
 * Both bounds are inclusive and expressed in bytes, mirroring the
 * `Range: bytes=start-end` header semantics.
 */
export interface RangeOptions {
  start: number;
  end?: number;
}

export interface GetStreamResult {
  stream: Readable;
  contentType?: string;
  size?: number;
  /**
   * Present when the request was served partially (HTTP 206).
   * Format per RFC 7233, e.g. "bytes 0-99/1234" or "bytes 0-99/*".
   */
  contentRange?: string;
}

export interface ListResult {
  /**
   * The requested page. Implementations apply ListOptions.offset and
   * ListOptions.limit before returning entries; callers must not slice again.
   */
  entries: FileEntry[];
  nextContinuationToken?: string;
  hasMore?: boolean;
  total?: number;
}

/**
 * Unified storage adapter interface.
 * All storage backends (S3, SFTP, etc.) implement this interface
 * to provide a consistent API for file operations.
 *
 * All paths are relative to the directory's rootPath and are
 * resolved by the caller before being passed to the adapter.
 */
export interface IStorageAdapter {
  /**
   * List files and folders at the given path.
   * Returns entries sorted: directories first, then files, both alphabetically.
   */
  list(remotePath: string, options?: ListOptions): Promise<FileEntry[] | ListResult>;

  /**
   * Get metadata for a single file or directory.
   */
  stat(remotePath: string): Promise<FileEntry>;

  /**
   * Get a readable stream for downloading a file.
   * The stream should be piped directly to the HTTP response.
   * When `range` is provided, only the requested byte range is streamed and
   * `contentRange` is returned so the caller can emit a 206 response.
   */
  getStream(remotePath: string, range?: RangeOptions): Promise<GetStreamResult>;

  /**
   * Upload a file from a readable stream.
   * The stream is piped directly from the HTTP request (no RAM buffering).
   */
  putStream(remotePath: string, stream: Readable, options?: PutStreamOptions): Promise<void>;

  /**
   * Create a directory (recursive).
   */
  mkdir(remotePath: string): Promise<void>;

  /**
   * Delete a file.
   */
  delete(remotePath: string): Promise<void>;

  /**
   * Delete a directory and all its contents (recursive).
   */
  deleteDir(remotePath: string): Promise<void>;

  /**
   * Rename or move a file/directory.
   */
  rename(oldPath: string, newPath: string): Promise<void>;

  /**
   * Check if a path exists.
   */
  exists(remotePath: string): Promise<boolean>;
}
