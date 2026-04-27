/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { IStorageAdapter, FileEntry } from '../adapters/types';
import { koaMulter as multer } from '@nocobase/utils';
import { DirectoryACL } from '../acl/directory-acl';
import { DirectoryAction, STORAGE_TYPE_S3, STORAGE_TYPE_SFTP } from '../../constants';

/**
 * Sanitize path to prevent directory traversal attacks.
 * Removes '..' components, normalizes separators, and ensures paths stay within bounds.
 */
function sanitizePath(inputPath: string): string {
  if (typeof inputPath !== 'string') {
    return '/';
  }

  // Normalize path separators
  let sanitized = inputPath.replace(/\\/g, '/');

  // Remove any '..' components
  const parts = sanitized.split('/').filter((p) => p !== '..' && p !== '.');
  sanitized = '/' + parts.filter(Boolean).join('/');

  return sanitized;
}

/**
 * Resolve the full remote path by combining directory rootPath and requested sub-path.
 */
function resolveRemotePath(rootPath: string, subPath: string): string {
  const normalizedRoot = rootPath.replace(/\/+$/, '') || '';
  const normalizedSub = sanitizePath(subPath);
  return normalizedRoot + normalizedSub;
}

/**
 * Convert a backend path back to the virtual path exposed to the browser.
 * Adapters return backend-native paths; the browser must only see paths
 * relative to the configured virtual directory root to avoid double-prefixing.
 */
function toVirtualPath(rootPath: string, remotePath: string): string {
  const normalizedRoot = sanitizePath(rootPath || '/').replace(/\/+$/, '');
  const normalizedRemote = sanitizePath(remotePath || '/').replace(/\/+$/, '');

  if (!normalizedRoot || normalizedRoot === '/') {
    return normalizedRemote || '/';
  }

  if (normalizedRemote === normalizedRoot) {
    return '/';
  }

  if (normalizedRemote.startsWith(normalizedRoot + '/')) {
    return normalizedRemote.slice(normalizedRoot.length) || '/';
  }

  return normalizedRemote || '/';
}

function normalizeEntryPath(rootPath: string, entry: FileEntry): FileEntry {
  return {
    ...entry,
    path: toVirtualPath(rootPath, entry.path),
  };
}

/**
 * Helper: get directory record by ID and check ACL in one call.
 */
async function getDirectoryWithACL(
  ctx: any,
  acl: DirectoryACL,
  action: DirectoryAction,
): Promise<{ directory: any; subPath: string } | null> {
  const { directoryId } = ctx.action.params;

  if (!directoryId) {
    ctx.throw(400, 'Missing directoryId parameter');
    return null;
  }

  const dirIdNum = Number(directoryId);
  if (Number.isNaN(dirIdNum)) {
    ctx.throw(400, 'Invalid directoryId parameter');
    return null;
  }

  const directory = await ctx.db.getRepository('externalStorageDirectories').findOne({
    filterByTk: dirIdNum,
  });

  if (!directory || !directory.get('enabled')) {
    ctx.throw(404, 'Directory not found or disabled');
    return null;
  }

  const currentRoles: string[] = ctx.state.currentRoles || [];
  const subPath = sanitizePath(ctx.action.params.path || '/');

  const hasAccess = await acl.checkAccess({
    directoryId: Number(directoryId),
    roles: currentRoles,
    action,
    subPath,
  });

  if (!hasAccess) {
    ctx.throw(403, 'Permission denied for this directory');
    return null;
  }

  return { directory, subPath };
}

/**
 * Register all external storage action handlers on the plugin.
 */
export function createExtStorageActions(acl: DirectoryACL, getAdapter: (directory: any) => Promise<IStorageAdapter>) {
  return {
    /**
     * GET extStorage:directories
     * List all directories accessible to the current user, with their allowed actions.
     */
    directories: async (ctx: any) => {
    const roleName = ctx.state.currentRole || 'anonymous';
    const currentRoles: string[] = ctx.state.currentRoles || [roleName];
    const accessibleIds = await acl.getAccessibleDirectories(currentRoles);

    if (accessibleIds.length === 0) {
      ctx.body = { data: [] };
      return;
    }

    const directories = await ctx.db.getRepository('externalStorageDirectories').find({
      filter: {
        id: { $in: accessibleIds },
        enabled: true,
      },
      sort: ['sort', 'name'],
    });

    // Enrich with allowed actions for each directory
    const directoryIds = directories.map((dir: any) => dir.get('id'));
    const bulkActions = await acl.getAllowedActionsBulk(directoryIds, currentRoles);

    const enriched = directories.map((dir: any) => {
      return {
        ...dir.toJSON(),
        allowedActions: bulkActions[dir.get('id')] || [],
      };
    });

    ctx.body = { data: enriched };
    },

    /**
     * GET extStorage:list
     * List files/folders at a path within a directory.
     * Requires 'list' permission.
     */
    list: async (ctx: any) => {
    const result = await getDirectoryWithACL(ctx, acl, 'list');
    if (!result) return;

    const { directory, subPath } = result;
    const adapter = await getAdapter(directory);
    const remotePath = resolveRemotePath(directory.get('rootPath'), subPath);

    try {
      const files = await adapter.list(remotePath);
      ctx.body = {
        data: files.map((entry) => normalizeEntryPath(directory.get('rootPath'), entry)),
        meta: {
          directoryId: directory.get('id'),
          directoryName: directory.get('name'),
          currentPath: subPath,
          rootPath: directory.get('rootPath'),
        },
      };
    } catch (error: any) {
      ctx.logger?.error?.(`[ext-storage] List failed for path "${remotePath}":`, error);
      ctx.throw(500, `Failed to list files: ${error.message}`);
    }
    },

    /**
     * GET extStorage:stat
     * Get metadata for a single file or directory.
     * Requires 'view' permission.
     */
    stat: async (ctx: any) => {
    const result = await getDirectoryWithACL(ctx, acl, 'view');
    if (!result) return;

    const { directory, subPath } = result;
    const adapter = await getAdapter(directory);
    const remotePath = resolveRemotePath(directory.get('rootPath'), subPath);

    try {
      const stat = await adapter.stat(remotePath);
      ctx.body = { data: normalizeEntryPath(directory.get('rootPath'), stat) };
    } catch (error: any) {
      ctx.throw(404, `File not found: ${error.message}`);
    }
    },

    /**
     * GET extStorage:download
     * Stream download a file from external storage.
     * Requires 'download' permission.
     * Sets proper headers for browser download / inline preview.
     */
    download: async (ctx: any) => {
    const result = await getDirectoryWithACL(ctx, acl, 'download');
    if (!result) return;

    const { directory, subPath } = result;
    const adapter = await getAdapter(directory);
    const remotePath = resolveRemotePath(directory.get('rootPath'), subPath);
    const mode = ctx.action.params.mode || 'attachment';

    try {
      const { stream, contentType, size } = await adapter.getStream(remotePath);
      const filename = encodeURIComponent(path.basename(subPath));

      ctx.set('Content-Type', contentType || 'application/octet-stream');
      if (size) {
        ctx.set('Content-Length', String(size));
      }

      if (mode === 'inline') {
        ctx.set('Content-Disposition', `inline; filename="${filename}"`);
      } else {
        ctx.set('Content-Disposition', `attachment; filename="${filename}"`);
      }

      ctx.set('Cache-Control', 'private, max-age=300');
      ctx.body = stream;
    } catch (error: any) {
      ctx.logger?.error?.(`[ext-storage] Download failed for "${remotePath}":`, error);
      ctx.throw(500, `Failed to download file: ${error.message}`);
    }
    },

    /**
     * POST extStorage:upload
     * Upload file(s) to a path within a directory.
     * Requires 'upload' permission.
     * Accepts multipart/form-data with 'file' field.
     */
    upload: async (ctx: any) => {
    const result = await getDirectoryWithACL(ctx, acl, 'upload');
    if (!result) return;

    const { directory, subPath } = result;
    const adapter = await getAdapter(directory);

    // Parse multipart using multer to disk
    try {
      const uploadMiddleware = multer({ dest: os.tmpdir() }).any();
      await uploadMiddleware(ctx, () => {});
    } catch (err: any) {
      ctx.throw(400, `Upload parsing error: ${err.message}`);
    }

    // Handle file uploads from Koa context (multer puts any() in ctx.files)
    const files = ctx.files || ctx.request?.files;
    if (!files || Object.keys(files).length === 0) {
      ctx.throw(400, 'No file provided');
      return;
    }

    let fileList: any[] = [];
    if (Array.isArray(files)) {
      fileList = files;
    } else if (files.file) {
      fileList = Array.isArray(files.file) ? files.file : [files.file];
    } else {
      Object.values(files).forEach((val: any) => {
        if (Array.isArray(val)) fileList.push(...val);
        else fileList.push(val);
      });
    }

    if (fileList.length === 0) {
      ctx.throw(400, 'No file provided');
      return;
    }

    const results: any[] = [];

    for (const file of fileList) {
      const fileName = file.originalname || file.originalFilename || file.newFilename || file.name || 'unnamed';
      const filePath = file.path || file.filepath;

      if (!filePath) {
        results.push({
          name: fileName,
          success: false,
          error: 'Missing file path in upload',
        });
        continue;
      }

      const targetPath = resolveRemotePath(
        directory.get('rootPath'),
        subPath.replace(/\/$/, '') + '/' + fileName,
      );

      try {
        const fileStream = fs.createReadStream(filePath);

        await adapter.putStream(targetPath, fileStream, {
          size: file.size,
          mimetype: file.mimetype || file.type,
        });

        results.push({
          name: fileName,
          path: subPath.replace(/\/$/, '') + '/' + fileName,
          size: file.size,
          mimetype: file.mimetype || file.type,
          success: true,
        });

        // Clean up temp file
        try {
          fs.unlinkSync(filePath);
        } catch { /* ignore */ }
      } catch (error: any) {
        ctx.logger?.error?.(`[ext-storage] Upload failed for "${targetPath}":`, error);
        results.push({
          name: fileName,
          success: false,
          error: error.message,
        });
      }
    }

    ctx.body = { data: results };
    },

    /**
     * POST extStorage:mkdir
     * Create a new folder at the specified path.
     * Requires 'mkdir' permission.
     */
    mkdir: async (ctx: any) => {
    const result = await getDirectoryWithACL(ctx, acl, 'mkdir');
    if (!result) return;

    const { directory, subPath } = result;
    const adapter = await getAdapter(directory);

    const body = ctx.request.body || {};
    const folderName = body.folderName || body.values?.folderName || ctx.action.params.values?.folderName || ctx.action.params.folderName;
    if (!folderName) {
      ctx.throw(400, 'Missing folderName parameter');
      return;
    }

    // Validate folder name
    if (/[\/\\<>:"|?*]/.test(folderName)) {
      ctx.throw(400, 'Invalid folder name');
      return;
    }

    const remotePath = resolveRemotePath(
      directory.get('rootPath'),
      subPath.replace(/\/$/, '') + '/' + folderName,
    );

    try {
      await adapter.mkdir(remotePath);
      ctx.body = {
        data: {
          name: folderName,
          path: subPath.replace(/\/$/, '') + '/' + folderName,
          type: 'directory',
          success: true,
        },
      };
    } catch (error: any) {
      ctx.logger?.error?.(`[ext-storage] Mkdir failed for "${remotePath}":`, error);
      ctx.throw(500, `Failed to create folder: ${error.message}`);
    }
    },

    /**
     * POST extStorage:delete
     * Delete a file or directory.
     * Requires 'delete' permission.
     */
    delete: async (ctx: any) => {
    const result = await getDirectoryWithACL(ctx, acl, 'delete');
    if (!result) return;

    const { directory, subPath } = result;
    const adapter = await getAdapter(directory);
    const remotePath = resolveRemotePath(directory.get('rootPath'), subPath);
    const itemType = ctx.action.params.values?.type || ctx.action.params.type || 'file';

    try {
      if (itemType === 'directory') {
        await adapter.deleteDir(remotePath);
      } else {
        await adapter.delete(remotePath);
      }
      ctx.body = { data: { success: true, path: subPath } };
    } catch (error: any) {
      ctx.logger?.error?.(`[ext-storage] Delete failed for "${remotePath}":`, error);
      ctx.throw(500, `Failed to delete: ${error.message}`);
    }
    },

    /**
     * GET extStorage:storageOptions
     * Return storage/config names usable by the settings UI.
     */
    storageOptions: async (ctx: any) => {
    const roleName = ctx.state.currentRole || 'anonymous';
    const currentRoles: string[] = ctx.state.currentRoles || [roleName];
    if (!currentRoles.includes('root') && !currentRoles.includes('admin')) {
      ctx.throw(403, 'Only administrators can list storage configuration options');
      return;
    }

    const data: { s3: any[]; sftp: any[] } = { s3: [], sftp: [] };

    try {
      if (ctx.db.getCollection('storages')) {
        const storages = await ctx.db.getRepository('storages').find({
          filter: { type: { $in: ['s3', STORAGE_TYPE_S3] } },
          sort: ['title', 'name'],
        });
        data.s3 = storages.map((storage: any) => ({
          id: storage.get('id'),
          name: storage.get('name'),
          title: storage.get('title') || storage.get('name'),
          type: storage.get('type'),
        }));
      }
    } catch (error: any) {
      ctx.logger?.warn?.('[ext-storage] Failed to load S3 storage options:', error);
    }

    try {
      if (ctx.db.getCollection('storages')) {
        const configs = await ctx.db.getRepository('storages').find({
          filter: { type: { $in: ['sftp', 'sftp-private'] } },
          sort: ['title', 'name'],
        });
        data.sftp = configs.map((config: any) => ({
          id: config.get('id'),
          name: config.get('name'),
          title: config.get('title') || config.get('name'),
          type: config.get('type'),
          host: config.get('options')?.host || config.get('host'),
          basePath: config.get('options')?.basePath || config.get('basePath') || '/',
        }));
      }
    } catch (error: any) {
      ctx.logger?.warn?.('[ext-storage] Failed to load SFTP options:', error);
    }

    ctx.logger?.info?.('[ext-storage] storageOptions data:', data);
    ctx.body = { data };
    },
  };
}
