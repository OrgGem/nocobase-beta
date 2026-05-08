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
import { STORAGE_TYPE_S3, STORAGE_TYPE_SFTP } from '../../constants';

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;

function getActionPayload(ctx: any) {
  return {
    ...(ctx.request?.query || {}),
    ...(ctx.action?.params || {}),
    ...(ctx.request?.body || {}),
    ...(ctx.action?.params?.values || {}),
  };
}

function clampListLimit(value: any) {
  const parsed = Number(value || DEFAULT_LIST_LIMIT);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(Math.floor(parsed), MAX_LIST_LIMIT);
}

function parseOffset(value: any) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function sortEntries(entries: FileEntry[], sort = 'name', order = 'asc') {
  const direction = order === 'desc' ? -1 : 1;
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    const av = a[sort] ?? a.name;
    const bv = b[sort] ?? b.name;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * direction;
    return String(av).localeCompare(String(bv)) * direction;
  });
}

function safeUploadFilename(value: string) {
  const normalized = String(value || 'unnamed').replace(/\\/g, '/');
  return path.posix.basename(normalized) || 'unnamed';
}

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

function getCurrentRoles(ctx: any): string[] {
  return Array.isArray(ctx.state?.currentRoles) ? ctx.state.currentRoles : [];
}

function getRecordValue(record: any, key: string) {
  return record?.get ? record.get(key) : record?.[key];
}

/**
 * Helper: get directory record by ID.
 * NocoBase's core ACL automatically applies data scope filtering based on the Role
 * before reaching this point. If `findOne` returns null, the user either provided
 * a bad ID or their Role data scope prevents access.
 */
async function getDirectoryRecord(ctx: any, requiredAction: string = 'view'): Promise<{ directory: any; subPath: string } | null> {
  // Use filterByTk which comes from the URL param automatically (e.g. /externalStorageDirectories:list/<id>)
  // Or explicitly from params if they sent it
  const filterByTk = ctx.action.params.filterByTk || ctx.action.params.directoryId;

  if (!filterByTk) {
    ctx.throw(400, 'Missing directory ID (filterByTk)');
    return null;
  }

  // Check NocoBase ACL explicitly for Data Scope
  const canAccess = ctx.can({
    resource: 'externalStorageDirectories',
    action: requiredAction,
  });

  if (!canAccess) {
    ctx.throw(403, 'Permission denied');
    return null;
  }

  // Apply the data scope filter returned by ACL
  let dataScopeFilter = canAccess.params?.filter || {};
  if (ctx.app.environment) {
    dataScopeFilter = ctx.app.environment.renderJsonTemplate(dataScopeFilter, {
      $user: ctx.state.currentUser?.toJSON ? ctx.state.currentUser.toJSON() : ctx.state.currentUser,
      $nRole: ctx.state.currentRole,
    });
  }

  // The collection is externalStorageDirectories
  const directory = await ctx.db.getRepository('externalStorageDirectories').findOne({
    filterByTk,
    filter: dataScopeFilter,
  });

  if (!directory || !directory.get('enabled')) {
    ctx.throw(404, 'Directory not found or access denied by ACL Data Scope');
    return null;
  }

  const subPath = sanitizePath(ctx.action.params.path || '/');

  return { directory, subPath };
}

/**
 * Register all external storage action handlers on the plugin.
 */
export function createExtStorageActions(getAdapter: (directory: any) => Promise<IStorageAdapter>) {
  return {
    /**
     * GET extStorage:directories
     * List all directories accessible to the current user, with their allowed actions.
     */
    directories: async (ctx: any) => {
      const canAccess = ctx.can({
        resource: 'externalStorageDirectories',
        action: 'view',
      });

      if (!canAccess) {
        ctx.body = { data: [] };
        return;
      }

      let dataScopeFilter = canAccess.params?.filter || {};
      if (ctx.app.environment) {
        dataScopeFilter = ctx.app.environment.renderJsonTemplate(dataScopeFilter, {
          $user: ctx.state.currentUser?.toJSON ? ctx.state.currentUser.toJSON() : ctx.state.currentUser,
          $nRole: ctx.state.currentRole,
        });
      }

      // Find directories accessible to the user (Data Scope applied automatically)
      const directories = await ctx.db.getRepository('externalStorageDirectories').find({
        filter: {
          $and: [
            { enabled: true },
            dataScopeFilter
          ]
        },
        sort: ['sort', 'name'],
      });

      // Retrieve update/destroy data scopes to populate allowedActions for the frontend FileBrowser
      const updateAccess = ctx.can({ resource: 'externalStorageDirectories', action: 'update' });
      const destroyAccess = ctx.can({ resource: 'externalStorageDirectories', action: 'destroy' });

      let updateFilter = updateAccess ? updateAccess.params?.filter || {} : { $and: [{ id: -1 }] };
      let destroyFilter = destroyAccess ? destroyAccess.params?.filter || {} : { $and: [{ id: -1 }] };

      if (ctx.app.environment) {
        updateFilter = ctx.app.environment.renderJsonTemplate(updateFilter, {
          $user: ctx.state.currentUser?.toJSON ? ctx.state.currentUser.toJSON() : ctx.state.currentUser,
          $nRole: ctx.state.currentRole,
        });
        destroyFilter = ctx.app.environment.renderJsonTemplate(destroyFilter, {
          $user: ctx.state.currentUser?.toJSON ? ctx.state.currentUser.toJSON() : ctx.state.currentUser,
          $nRole: ctx.state.currentRole,
        });
      }

      const updatableIds = updateAccess ? (await ctx.db.getRepository('externalStorageDirectories').find({ filter: updateFilter, fields: ['id'] })).map(d => d.get('id')) : [];
      const destroyableIds = destroyAccess ? (await ctx.db.getRepository('externalStorageDirectories').find({ filter: destroyFilter, fields: ['id'] })).map(d => d.get('id')) : [];

      const dataWithActions = directories.map(dir => {
        const id = dir.get('id');
        const allowedActions = ['list', 'view', 'download', 'exists'];
        if (updatableIds.includes(id)) {
          allowedActions.push('upload', 'mkdir', 'rename', 'update');
        }
        if (destroyableIds.includes(id)) {
          allowedActions.push('delete', 'destroy');
        }
        return {
          ...dir.toJSON(),
          allowedActions,
        };
      });

      ctx.body = { data: dataWithActions };
    },

    /**
     * GET extStorage:list
     * List files/folders at a path within a directory.
     * Requires 'list' permission.
     */
    list: async (ctx: any) => {
      const result = await getDirectoryRecord(ctx, 'view');
    if (!result) return;

    const { directory, subPath } = result;
    const adapter = await getAdapter(directory);
    const remotePath = resolveRemotePath(directory.get('rootPath'), subPath);
    const payload = getActionPayload(ctx);
    const limit = clampListLimit(payload.limit);
    const offset = parseOffset(payload.offset ?? payload.page);
    const type = payload.type;
    const search = String(payload.search || payload.q || '').toLowerCase();

    try {
      let files = (await adapter.list(remotePath)).map((entry) => normalizeEntryPath(directory.get('rootPath'), entry));
      if (type === 'file' || type === 'directory') {
        files = files.filter((entry) => entry.type === type);
      }
      if (search) {
        files = files.filter((entry) => entry.name.toLowerCase().includes(search));
      }
      const sorted = sortEntries(files, payload.sort || 'name', payload.order || 'asc');
      const pageData = sorted.slice(offset, offset + limit);
      ctx.body = {
        data: pageData,
        meta: {
          directoryId: directory.get('id'),
          directoryName: directory.get('name'),
          currentPath: subPath,
          rootPath: directory.get('rootPath'),
          total: sorted.length,
          limit,
          offset,
          hasMore: offset + limit < sorted.length,
          nextOffset: offset + limit < sorted.length ? offset + limit : null,
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
      const result = await getDirectoryRecord(ctx, 'view');
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
      const result = await getDirectoryRecord(ctx, 'view');
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
      ctx.withoutDataWrapping = true;
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
      const result = await getDirectoryRecord(ctx, 'update');
    if (!result) return;

    const { directory, subPath } = result;
    const adapter = await getAdapter(directory);

    if (!ctx.request?.is?.('multipart/*')) {
      if (!ctx.req || subPath === '/') {
        ctx.throw(400, 'Raw stream upload requires a file path');
        return;
      }

      const remotePath = resolveRemotePath(directory.get('rootPath'), subPath);
      try {
        await adapter.putStream(remotePath, ctx.req, {
          size: Number(ctx.request?.headers?.['content-length'] || 0) || undefined,
          mimetype: ctx.request?.headers?.['content-type'],
        });
        ctx.body = { data: { path: subPath, success: true } };
      } catch (error: any) {
        ctx.logger?.error?.(`[ext-storage] Raw upload failed for "${remotePath}":`, error);
        ctx.throw(500, `Failed to upload file: ${error.message}`);
      }
      return;
    }

    try {
      const uploadMiddleware = multer({ dest: os.tmpdir() }).any();
      await uploadMiddleware(ctx, () => {});
    } catch (err: any) {
      ctx.throw(400, `Upload parsing error: ${err.message}`);
      return;
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
      const fileName = safeUploadFilename(file.originalname || file.originalFilename || file.newFilename || file.name);
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

      } catch (error: any) {
        ctx.logger?.error?.(`[ext-storage] Upload failed for "${targetPath}":`, error);
        results.push({
          name: fileName,
          success: false,
          error: error.message,
        });
      } finally {
        if (filePath) {
          fs.unlink(filePath, () => {});
        }
      }
    }

    ctx.body = { data: results };
    },

    /**
     * POST extStorage:rename
     * Rename or move a file/directory.
     * Requires 'update' permission.
     */
    rename: async (ctx: any) => {
      const result = await getDirectoryRecord(ctx, 'update');
    if (!result) return;

    const { directory } = result;
    const payload = getActionPayload(ctx);
    const oldSubPath = sanitizePath(payload.oldPath || payload.from || payload.path || '/');
    const newSubPath = sanitizePath(payload.newPath || payload.to || '/');

    if (oldSubPath === '/' || newSubPath === '/') {
      ctx.throw(400, 'Refusing to rename root path');
      return;
    }

    const adapter = await getAdapter(directory);
    const oldRemotePath = resolveRemotePath(directory.get('rootPath'), oldSubPath);
    const newRemotePath = resolveRemotePath(directory.get('rootPath'), newSubPath);

    try {
      await adapter.rename(oldRemotePath, newRemotePath);
      ctx.body = { data: { oldPath: oldSubPath, newPath: newSubPath, success: true } };
    } catch (error: any) {
      ctx.logger?.error?.(`[ext-storage] Rename failed from "${oldRemotePath}" to "${newRemotePath}":`, error);
      ctx.throw(500, `Failed to rename: ${error.message}`);
    }
    },

    /**
     * GET extStorage:exists
     * Check whether a file or directory exists.
     * Requires 'view' permission.
     */
    exists: async (ctx: any) => {
      const result = await getDirectoryRecord(ctx, 'view');
    if (!result) return;

    const { directory, subPath } = result;
    const adapter = await getAdapter(directory);
    const remotePath = resolveRemotePath(directory.get('rootPath'), subPath);

    try {
      ctx.body = { data: { path: subPath, exists: await adapter.exists(remotePath) } };
    } catch (error: any) {
      ctx.logger?.error?.(`[ext-storage] Exists check failed for "${remotePath}":`, error);
      ctx.throw(500, `Failed to check path: ${error.message}`);
    }
    },

    /**
     * POST extStorage:mkdir
     * Create a new folder at the specified path.
     * Requires 'mkdir' permission.
     */
    mkdir: async (ctx: any) => {
      const result = await getDirectoryRecord(ctx, 'update');
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
      const result = await getDirectoryRecord(ctx, 'destroy');
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
      const canCreateDir = await ctx.app.acl.can({
        roles: getCurrentRoles(ctx),
        resource: 'externalStorageDirectories',
        action: 'create', // Only users who can create directories need to list storage options
      });

      if (!canCreateDir && !getCurrentRoles(ctx).includes('root')) {
        ctx.throw(403, 'Permission denied');
        return;
      }

      const s3Access = await ctx.app.acl.can({ roles: getCurrentRoles(ctx), resource: 'storages', action: 'list' });
      const sftpAccess = await ctx.app.acl.can({ roles: getCurrentRoles(ctx), resource: 'sftpStorageConfigs', action: 'list' });

      let s3Filter = s3Access?.params?.filter || {};
      let sftpFilter = sftpAccess?.params?.filter || {};

      if (ctx.app.environment) {
        s3Filter = ctx.app.environment.renderJsonTemplate(s3Filter, {
          $user: ctx.state.currentUser?.toJSON ? ctx.state.currentUser.toJSON() : ctx.state.currentUser,
          $nRole: ctx.state.currentRole,
        });
        sftpFilter = ctx.app.environment.renderJsonTemplate(sftpFilter, {
          $user: ctx.state.currentUser?.toJSON ? ctx.state.currentUser.toJSON() : ctx.state.currentUser,
          $nRole: ctx.state.currentRole,
        });
      }

      const data: { s3: any[]; sftp: any[] } = { s3: [], sftp: [] };

      try {
        if (s3Access && ctx.db.getCollection('storages')) {
          const storages = await ctx.db.getRepository('storages').find({
            filter: { $and: [{ type: { $in: ['s3', STORAGE_TYPE_S3] } }, s3Filter] },
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
        if (sftpAccess && ctx.db.getCollection('sftpStorageConfigs')) {
          const configs = await ctx.db.getRepository('sftpStorageConfigs').find({
            filter: sftpFilter,
            sort: ['title', 'name'],
          });
          data.sftp = configs.map((config: any) => ({
            id: config.get('id'),
            name: config.get('name'),
            title: config.get('title') || config.get('name'),
            type: 'sftp-private',
            host: config.get('host'),
            basePath: config.get('basePath') || '/',
          }));
        }
      } catch (error: any) {
        ctx.logger?.warn?.('[ext-storage] Failed to load SFTP options:', error);
      }

      try {
        if (s3Access && ctx.db.getCollection('storages')) {
          const existingSftpNames = new Set(data.sftp.map((item) => item.name));
          const storages = await ctx.db.getRepository('storages').find({
            filter: { $and: [{ type: STORAGE_TYPE_SFTP }, s3Filter] },
            sort: ['title', 'name'],
          });

          for (const storage of storages) {
            const parsed = ctx.app.environment
              ? ctx.app.environment.renderJsonTemplate(storage.toJSON())
              : storage.toJSON();
            const name = storage.get('name');

            if (existingSftpNames.has(name)) {
              continue;
            }

            data.sftp.push({
              id: storage.get('id'),
              name,
              title: storage.get('title') || name,
              type: STORAGE_TYPE_SFTP,
              host: parsed.options?.host,
              basePath: parsed.options?.basePath || '/',
              source: 'storages',
            });
            existingSftpNames.add(name);
          }
        }
      } catch (error: any) {
        ctx.logger?.warn?.('[ext-storage] Failed to load File Manager SFTP storage options:', error);
      }

      ctx.body = { data };
    },

    /**
     * GET extStorage:rolePermissions
     * Returns parsed directory access permissions for a specific role.
     */
    rolePermissions: async (ctx: any) => {
      const currentRoles = getCurrentRoles(ctx);
      if (!currentRoles.includes('root')) {
         const canAccessRoles = await ctx.app.acl.can({ roles: currentRoles, resource: 'roles', action: 'update' });
         if (!canAccessRoles) return ctx.throw(403, 'Permission denied');
      }

      const roleName = ctx.action.params.roleName;
      if (!roleName) return ctx.throw(400, 'roleName is required');

      const resource = await ctx.db.getRepository('rolesResources').findOne({
        filter: { roleName, name: 'externalStorageDirectories' },
      });
      if (!resource) {
        ctx.body = { data: { view: [], update: [], destroy: [] } };
        return;
      }
      const actions = await ctx.db.getRepository('rolesResourcesActions').find({
        filter: { rolesResourceId: getRecordValue(resource, 'id') },
        appends: ['scope'],
      });

      const result = { view: [], update: [], destroy: [] };
      for (const action of actions) {
        const actionData = action.toJSON ? action.toJSON() : action;
        const actionName = actionData.name;
        if (result[actionName]) {
          const scopeRow = actionData.scope;
          const scope = scopeRow?.scope || scopeRow; // handle both populated relation and raw json if legacy
          try {
            if (scope && scope.$and && scope.$and[0] && scope.$and[0].id) {
              if (scope.$and[0].id.$in) {
                result[actionName] = scope.$and[0].id.$in;
              } else if (typeof scope.$and[0].id === 'number' || typeof scope.$and[0].id === 'string') {
                result[actionName] = [scope.$and[0].id];
              }
            }
          } catch (e) {
            // Unrecognized scope structure, skip
          }
        }
      }
      ctx.body = result;
    },

    /**
     * POST extStorage:updateRolePermissions
     * Update Data Scopes in rolesResourcesActions to reflect simple ID lists.
     */
    updateRolePermissions: async (ctx: any) => {
      const currentRoles = getCurrentRoles(ctx);
      if (!currentRoles.includes('root')) {
         const canAccessRoles = await ctx.app.acl.can({ roles: currentRoles, resource: 'roles', action: 'update' });
         if (!canAccessRoles) return ctx.throw(403, 'Permission denied');
      }

      const payload = ctx.action.params.values || ctx.request.body || {};
      const roleName = payload.roleName || ctx.action.params.roleName;
      const permissions = payload.values || {};
      if (!roleName) return ctx.throw(400, 'roleName is required');

      const resourceRepo = ctx.db.getRepository('rolesResources');
      let resource = await resourceRepo.findOne({ filter: { roleName, name: 'externalStorageDirectories' } });
      if (!resource) {
         resource = await resourceRepo.create({ values: { roleName, name: 'externalStorageDirectories', usingActionsConfig: true } });
      } else if (!getRecordValue(resource, 'usingActionsConfig')) {
         await resource.update({ usingActionsConfig: true });
      }

      const rolesResourceId = getRecordValue(resource, 'id');
      const actionsRepo = ctx.db.getRepository('rolesResourcesActions');
      for (const actionName of ['view', 'update', 'destroy']) {
         const ids = permissions[actionName] || [];
         const action = await actionsRepo.findOne({
           filter: { rolesResourceId, name: actionName },
           appends: ['scope']
         });

         if (ids.length === 0) {
            // Remove the action if no ids allowed
            if (action) await action.destroy();
         } else {
            const scopeJson = { $and: [{ id: { $in: ids } }] };
            if (action) {
               const actionData = action.toJSON ? action.toJSON() : action;
               const actionScope = actionData.scope;
               const actionScopeId = getRecordValue(actionScope, 'id') || actionData.scopeId || getRecordValue(action, 'scopeId');
               // Update existing action
               if (actionScopeId) {
                  // update the related scope record
                  await ctx.db.getRepository('rolesResourcesScopes').update({
                     filterByTk: actionScopeId,
                     values: { scope: scopeJson }
                  });
               } else {
                  // create a new scope record and link it
                  const newScope = await ctx.db.getRepository('rolesResourcesScopes').create({
                     values: { scope: scopeJson }
                  });
                  await action.update({ scopeId: getRecordValue(newScope, 'id') });
               }
            } else {
               const newScope = await ctx.db.getRepository('rolesResourcesScopes').create({
                  values: { scope: scopeJson }
               });
               await actionsRepo.create({
                 values: { rolesResourceId, name: actionName, scopeId: getRecordValue(newScope, 'id') }
               });
            }
         }
      }

      // Force reload the ACL cache in memory for this resource
      try {
         await resource.writeToACL({ acl: ctx.app.acl });
      } catch (e) {
         ctx.logger?.warn?.('[ext-storage] Failed to write resource to ACL memory cache:', e);
      }

      ctx.body = { data: 'ok' };
    },
  };
}
