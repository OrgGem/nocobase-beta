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
import { IStorageAdapter, FileEntry, ListOptions, RangeOptions } from '../adapters/types';
import { koaMulter as multer, uid } from '@nocobase/utils';
import { NAMESPACE, STORAGE_TYPE_S3, STORAGE_TYPE_SFTP } from '../../constants';
import { buildContentDisposition } from '../content-disposition';
import { TtlCache } from '../list-cache';
import { verifyDownloadSignature } from '../url-signing';

export interface ExtStorageActionsOptions {
  /**
   * Shared TTL cache for expensive full-scan listings (S3 recursive search).
   * Pass a TtlCache instance to enable; omit to disable caching.
   */
  listCache?: TtlCache<FileEntry[]>;
}

function getListCacheTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.EXT_STORAGE_LIST_CACHE_TTL_MS);
  if (!Number.isFinite(raw) || raw < 0) {
    return 30_000;
  }
  return Math.floor(raw);
}

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;

/**
 * Upload limits. Configurable via environment variables so deployments can
 * tune them without code changes:
 * - EXT_STORAGE_MAX_UPLOAD_MB  (default: 200) — max size per uploaded file
 * - EXT_STORAGE_MAX_UPLOAD_FILES (default: 50) — max number of files per request
 */
export const DEFAULT_MAX_UPLOAD_MB = 200;
export const DEFAULT_MAX_UPLOAD_FILES = 50;

export function getMaxUploadBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.EXT_STORAGE_MAX_UPLOAD_MB);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_MAX_UPLOAD_MB * 1024 * 1024;
  }
  return Math.floor(raw * 1024 * 1024);
}

export function getMaxUploadFiles(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.EXT_STORAGE_MAX_UPLOAD_FILES);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_MAX_UPLOAD_FILES;
  }
  return Math.floor(raw);
}

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

const SAFE_INLINE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/webm',
  'video/mp4',
  'video/ogg',
  'video/webm',
]);

function safeContentType(value: unknown): string {
  if (typeof value !== 'string') return 'application/octet-stream';
  const type = value.split(';', 1)[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) ? type : 'application/octet-stream';
}

/**
 * Parse a single-range `Range: bytes=start-end` header (RFC 7233).
 * Returns null when the header is absent, malformed, a multi-range request
 * (unsupported — served as 200 full content), or syntactically invalid.
 * Suffix ranges ("bytes=-500") become { start: size-500 } once the total
 * size is known; open-ended ranges ("bytes=100-") keep end undefined.
 */
export function parseRangeHeader(rangeHeader: string | undefined, totalSize?: number): RangeOptions | null {
  if (!rangeHeader || typeof rangeHeader !== 'string') {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) {
    return null;
  }

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') {
    return null;
  }

  // Multi-range ("bytes=0-1,5-9") is rejected by the regex above; serve 200.

  let start: number;
  let end: number | undefined;

  if (rawStart === '') {
    // Suffix form: last N bytes. Requires knowing the total size.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      return null;
    }
    if (totalSize === undefined) {
      return null;
    }
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else {
    start = Number(rawStart);
    if (!Number.isFinite(start)) {
      return null;
    }
    if (rawEnd !== '') {
      end = Number(rawEnd);
      if (!Number.isFinite(end) || end < start) {
        return null;
      }
    }
  }

  if (totalSize !== undefined && totalSize > 0 && start >= totalSize) {
    // Unsatisfiable — caller should respond 416.
    return { start: -1 };
  }

  return { start, end };
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
  if (Array.isArray(ctx.state?.currentRoles) && ctx.state.currentRoles.length) {
    return ctx.state.currentRoles;
  }
  if (typeof ctx.state?.currentRole === 'string' && ctx.state.currentRole) {
    return [ctx.state.currentRole];
  }
  return [];
}

function getRecordValue(record: any, key: string) {
  return record?.get ? record.get(key) : record?.[key];
}

/**
 * Parse a NocoBase data scope into a canonical directory id list.
 *
 * Returns `null` when the scope uses operators/expression structures that
 * cannot be safely represented as the simple `id $in [...]` list this plugin's
 * permission UI manages (e.g. `$or`, `$ne`, template expressions). Returning
 * `null` lets callers *refuse to overwrite* those complex scopes instead of
 * silently replacing them.
 */
type DirectoryId = number | string;
type PermissionAction = 'view' | 'update' | 'destroy';
const PERMISSION_ACTIONS: PermissionAction[] = ['view', 'update', 'destroy'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isDirectoryId(value: unknown): value is DirectoryId {
  return (
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === 'string' && value.length > 0 && !value.includes('{{') && !value.includes('}}'))
  );
}

export function extractDirectoryIds(scope: unknown): DirectoryId[] | null {
  if (!isRecord(scope)) return null;
  const keys = Object.keys(scope);
  if (keys.length !== 1) return null;

  if (keys[0] === '$and') {
    const clauses = scope.$and;
    return Array.isArray(clauses) && clauses.length === 1 ? extractDirectoryIds(clauses[0]) : null;
  }
  if (keys[0] !== 'id') return null;

  const id = scope.id;
  if (isDirectoryId(id)) return [id];
  if (!isRecord(id) || Object.keys(id).length !== 1 || !Array.isArray(id.$in)) return null;
  return id.$in.every(isDirectoryId) ? id.$in : null;
}

function getManagedActionIds(action: unknown): DirectoryId[] | null {
  if (!isRecord(action)) return null;
  const data: unknown = typeof action.toJSON === 'function' ? action.toJSON() : action;
  if (!isRecord(data)) return null;
  const scopeRow = data.scope;
  if (!isRecord(scopeRow) || scopeRow.key === 'own') return null;
  return extractDirectoryIds('scope' in scopeRow ? scopeRow.scope : scopeRow);
}

type DirectoryAclContext = {
  app: {
    acl: {
      getRole?: (name: string) => { getStrategy?: () => { options?: { actions?: unknown } } | null } | undefined;
      can: (options: { role: string; resource: string; action: string }) => unknown;
    };
  };
};

function hasInheritedDirectoryPermissions(ctx: DirectoryAclContext, roleName: string): boolean {
  const actions = new Set(['view', 'create', 'update', 'destroy']);
  const role = ctx.app.acl.getRole?.(roleName);
  const strategyActions: unknown = role?.getStrategy?.()?.options?.actions;
  if (Array.isArray(strategyActions)) {
    for (const action of strategyActions) {
      if (typeof action === 'string') actions.add(action.split(':')[0]);
    }
  } else if (typeof strategyActions === 'string' && strategyActions !== '*') {
    actions.add(strategyActions.split(':')[0]);
  }
  return [...actions].some((action) =>
    ctx.app.acl.can({ role: roleName, resource: 'externalStorageDirectories', action }),
  );
}

/**
 * Load the directory record by ID without any ACL check.
 * Callers must enforce authorization themselves.
 */
async function loadDirectoryRecord(ctx: any): Promise<any | null> {
  const filterByTk = ctx.action.params.filterByTk || ctx.action.params.directoryId;
  if (!filterByTk) {
    ctx.throw(400, 'Missing directory ID (filterByTk)');
    return null;
  }

  const directory = await ctx.db.getRepository('externalStorageDirectories').findOne({
    filterByTk,
  });

  if (!directory || !directory.get('enabled')) {
    ctx.throw(404, 'Directory not found');
    return null;
  }

  return directory;
}

/**
 * Helper: get directory record by ID.
 * NocoBase's core ACL automatically applies data scope filtering based on the Role
 * before reaching this point. If `findOne` returns null, the user either provided
 * a bad ID or their Role data scope prevents access.
 */
async function getDirectoryRecord(
  ctx: any,
  requiredAction = 'view',
): Promise<{ directory: any; subPath: string } | null> {
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

  const filterByTk = ctx.action.params.filterByTk || ctx.action.params.directoryId;
  if (!filterByTk) {
    ctx.throw(400, 'Missing directory ID (filterByTk)');
    return null;
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
export function createExtStorageActions(
  getAdapter: (directory: any) => Promise<IStorageAdapter>,
  options: ExtStorageActionsOptions = {},
) {
  const listCache = options.listCache ?? new TtlCache<FileEntry[]>({ ttlMs: getListCacheTtlMs(), maxEntries: 200 });

  /** Drop cached listings for a directory after any mutation. */
  const invalidateDirectoryCache = (directory: any) => {
    listCache?.invalidatePrefix(`${directory.get('id')}|`);
  };

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
          $and: [{ enabled: true }, dataScopeFilter],
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

      const updatableIds = updateAccess
        ? (await ctx.db.getRepository('externalStorageDirectories').find({ filter: updateFilter, fields: ['id'] })).map(
            (d) => d.get('id'),
          )
        : [];
      const destroyableIds = destroyAccess
        ? (
            await ctx.db.getRepository('externalStorageDirectories').find({ filter: destroyFilter, fields: ['id'] })
          ).map((d) => d.get('id'))
        : [];

      const dataWithActions = directories.map((dir) => {
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

      const options: ListOptions = {
        limit,
        offset,
        continuationToken: payload.continuationToken,
        search,
        type,
      };

      try {
        // Full-scan listings (S3 recursive search) are expensive; serve
        // repeated identical scans from a short-lived cache.
        const cacheKey = `${directory.get('id')}|${remotePath}|${type || ''}|${search}`;
        const cachedEntries = listCache?.get(cacheKey);
        if (cachedEntries) {
          const sortedCached = sortEntries(cachedEntries, payload.sort || 'name', payload.order || 'asc');
          const pageDataCached = sortedCached.slice(offset, offset + limit);
          ctx.body = {
            data: pageDataCached,
            meta: {
              directoryId: directory.get('id'),
              directoryName: directory.get('name'),
              currentPath: subPath,
              rootPath: directory.get('rootPath'),
              total: sortedCached.length,
              limit,
              offset,
              hasMore: offset + limit < sortedCached.length,
              nextOffset: offset + limit < sortedCached.length ? offset + limit : null,
              cached: true,
            },
          };
          return;
        }

        const filesOrResult = await adapter.list(remotePath, options);
        let pageData: FileEntry[];
        const meta: any = {
          directoryId: directory.get('id'),
          directoryName: directory.get('name'),
          currentPath: subPath,
          rootPath: directory.get('rootPath'),
        };

        if (Array.isArray(filesOrResult)) {
          // Adapter returned all entries (e.g. SFTP with no pagination, or S3 with search).
          // Sort / filter / slice on the server side.
          let files = filesOrResult.map((entry) => normalizeEntryPath(directory.get('rootPath'), entry));
          if (type === 'file' || type === 'directory') {
            files = files.filter((entry) => entry.type === type);
          }
          if (search) {
            files = files.filter((entry) => entry.name.toLowerCase().includes(search));
          }
          listCache?.set(cacheKey, files);
          const sorted = sortEntries(files, payload.sort || 'name', payload.order || 'asc');
          pageData = sorted.slice(offset, offset + limit);
          meta.total = sorted.length;
          meta.limit = limit;
          meta.offset = offset;
          meta.hasMore = offset + limit < sorted.length;
          meta.nextOffset = offset + limit < sorted.length ? offset + limit : null;
        } else {
          // Adapter returned a paginated ListResult (e.g. S3 without search).
          // Apply type/search filters (which aren't applied by the adapter for ListResult).
          let entries = filesOrResult.entries.map((entry) => normalizeEntryPath(directory.get('rootPath'), entry));
          if (type === 'file' || type === 'directory') {
            entries = entries.filter((entry) => entry.type === type);
          }
          if (search) {
            entries = entries.filter((entry) => entry.name.toLowerCase().includes(search));
          }

          // A ListResult is already the requested offset/limit page. In particular,
          // SFTP applies offset before returning its entries; slicing here again would
          // make every page after the first appear empty.
          pageData = entries;

          meta.limit = limit;
          meta.offset = offset;
          meta.continuationToken = payload.continuationToken;
          meta.nextContinuationToken = filesOrResult.nextContinuationToken;
          meta.hasMore = filesOrResult.hasMore ?? !!filesOrResult.nextContinuationToken;
          if (filesOrResult.total !== undefined) {
            meta.total = filesOrResult.total;
          }
        }

        ctx.body = {
          data: pageData,
          meta,
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
     * Sets proper headers for browser download / inline preview.
     * Supports single-range HTTP Range requests (RFC 7233) so media seeking
     * and resumable downloads work; multi-range requests are served as 200.
     *
     * Authorization accepts either:
     * - a valid signed URL (directoryId+path+mode+expires HMAC) — the grant was
     *   issued by the server after an ACL check, so no per-request ACL is needed;
     * - or the legacy path: a logged-in user whose role passes the directory
     *   data-scope check (token query param / Authorization header).
     */
    download: async (ctx: any) => {
      const signature = ctx.action.params.signature;
      const expiresParam = ctx.action.params.expires;
      let result: { directory: any; subPath: string } | null = null;

      if (signature) {
        const payload = {
          directoryId: ctx.action.params.directoryId ?? ctx.action.params.filterByTk,
          path: sanitizePath(ctx.action.params.path || '/'),
          mode: (ctx.action.params.mode === 'inline' ? 'inline' : 'attachment') as 'inline' | 'attachment',
          expires: Number(expiresParam),
        };
        if (!Number.isFinite(payload.expires)) {
          ctx.throw(400, 'Invalid signed URL expiry');
          return;
        }
        if (payload.expires <= Date.now()) {
          ctx.throw(403, 'Signed URL expired');
          return;
        }
        if (!verifyDownloadSignature(payload as any, String(signature))) {
          ctx.throw(403, 'Invalid signature');
          return;
        }

        // Bind the lookup to the exact directory id covered by the signature.
        // loadDirectoryRecord prefers filterByTk over directoryId, so if both
        // are present and differ, a signed URL for directory A could otherwise
        // be pointed at directory B by simply appending `filterByTk=B`.
        const rawFilterByTk = ctx.action.params.filterByTk;
        const rawDirectoryId = ctx.action.params.directoryId;
        if (
          rawFilterByTk !== undefined &&
          rawDirectoryId !== undefined &&
          String(rawFilterByTk) !== String(rawDirectoryId)
        ) {
          ctx.throw(403, 'Invalid signature');
          return;
        }

        const directory = await loadDirectoryRecord(ctx);
        if (!directory) return;
        result = { directory, subPath: payload.path };
      } else {
        result = await getDirectoryRecord(ctx, 'view');
      }

      if (!result) return;

      const { directory, subPath } = result;
      const adapter = await getAdapter(directory);
      const remotePath = resolveRemotePath(directory.get('rootPath'), subPath);
      const mode = ctx.action.params.mode || 'attachment';

      try {
        // Resolve the range first: stat() is a cheap metadata call (S3 HEAD /
        // SFTP stat) and lets suffix ranges ("bytes=-500") be resolved without
        // opening a throwaway data stream.
        let range: RangeOptions | null = null;
        let totalSize: number | undefined;
        const rangeHeader = ctx.get?.('range') || ctx.request?.headers?.range;
        if (rangeHeader) {
          const stat = await adapter.stat(remotePath).catch(() => null);
          totalSize = stat && stat.type === 'file' ? stat.size : undefined;
          range = parseRangeHeader(rangeHeader, totalSize);
          if (range && range.start === -1) {
            ctx.set('Content-Range', `bytes */${totalSize ?? '*'}`);
            ctx.throw(416, 'Requested range not satisfiable');
            return;
          }
        }

        const { stream, contentType, size, contentRange } = await adapter.getStream(remotePath, range ?? undefined);

        const filename = path.basename(subPath);

        const responseContentType = safeContentType(contentType);
        const disposition = mode === 'inline' && SAFE_INLINE_TYPES.has(responseContentType) ? 'inline' : 'attachment';
        ctx.set('Content-Type', responseContentType);
        ctx.set('X-Content-Type-Options', 'nosniff');
        ctx.set('Content-Security-Policy', "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'");
        ctx.set('Accept-Ranges', 'bytes');
        if (size !== undefined && size !== null) {
          // When serving a range this is the partial length, not the total.
          ctx.set('Content-Length', String(size));
        }
        if (range) {
          ctx.status = 206;
          if (contentRange) {
            ctx.set('Content-Range', contentRange);
          } else if (totalSize !== undefined) {
            ctx.set('Content-Range', `bytes ${range.start}-${range.start + size - 1}/${totalSize}`);
          }
        }

        ctx.set('Content-Disposition', buildContentDisposition(filename, disposition));

        // Private: browser/CDN may cache per-user, but permission revocation
        // takes up to this window to be reflected for already-cached responses.
        ctx.set('Cache-Control', 'private, max-age=300');
        ctx.withoutDataWrapping = true;
        ctx.body = stream;
      } catch (error: any) {
        if (error?.status === 416) {
          throw error;
        }
        ctx.logger?.error?.(`[ext-storage] Download failed for "${remotePath}":`, error);
        ctx.throw(500, `Failed to download file: ${error.message}`);
      }
    },

    /**
     * POST extStorage:upload
     * Upload file(s) to a path within a directory.
     * Requires 'upload' permission.
     * Accepts multipart/form-data with 'file' field.
     *
     * Size/count limits (env-tunable):
     * - EXT_STORAGE_MAX_UPLOAD_MB (default 200) per file
     * - EXT_STORAGE_MAX_UPLOAD_FILES (default 50) per request
     * Oversized requests are rejected with 413 before any storage I/O.
     */
    upload: async (ctx: any) => {
      const result = await getDirectoryRecord(ctx, 'update');
      if (!result) return;

      const { directory, subPath } = result;
      const adapter = await getAdapter(directory);

      const maxBytes = getMaxUploadBytes();
      const maxFiles = getMaxUploadFiles();

      if (!ctx.request?.is?.('multipart/*')) {
        if (!ctx.req || subPath === '/') {
          ctx.throw(400, 'Raw stream upload requires a file path');
          return;
        }

        // Single-file raw stream uploads are bounded by the per-file limit.
        const declaredLength = Number(ctx.request?.headers?.['content-length'] || 0);
        if (declaredLength && declaredLength > maxBytes) {
          ctx.throw(
            413,
            `Upload too large: content-length ${declaredLength} bytes exceeds the ${Math.floor(
              maxBytes / (1024 * 1024),
            )}MB limit`,
          );
          return;
        }

        const remotePath = resolveRemotePath(directory.get('rootPath'), subPath);
        try {
          await adapter.putStream(remotePath, ctx.req, {
            size: Number(ctx.request?.headers?.['content-length'] || 0) || undefined,
            mimetype: ctx.request?.headers?.['content-type'],
          });
          invalidateDirectoryCache(directory);
          ctx.body = { data: { path: subPath, success: true } };
        } catch (error: any) {
          ctx.logger?.error?.(`[ext-storage] Raw upload failed for "${remotePath}":`, error);
          ctx.throw(500, `Failed to upload file: ${error.message}`);
        }
        return;
      }

      try {
        const uploadMiddleware = multer({
          dest: os.tmpdir(),
          limits: {
            fileSize: maxBytes,
            files: maxFiles,
          },
        }).any();
        await uploadMiddleware(ctx, () => {});
      } catch (err: any) {
        if (err?.code === 'LIMIT_FILE_SIZE') {
          ctx.throw(413, `Upload too large: file exceeds the ${Math.floor(maxBytes / (1024 * 1024))}MB limit`);
          return;
        }
        if (err?.code === 'LIMIT_FILE_COUNT') {
          ctx.throw(413, `Too many files: maximum ${maxFiles} files per request`);
          return;
        }
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
        const fileName = safeUploadFilename(
          file.originalname || file.originalFilename || file.newFilename || file.name,
        );
        const filePath = file.path || file.filepath;

        if (!filePath) {
          results.push({
            name: fileName,
            success: false,
            error: 'Missing file path in upload',
          });
          continue;
        }

        const targetPath = resolveRemotePath(directory.get('rootPath'), subPath.replace(/\/$/, '') + '/' + fileName);

        try {
          const fileStream = fs.createReadStream(filePath);

          await adapter.putStream(targetPath, fileStream, {
            size: file.size,
            mimetype: file.mimetype || file.type,
          });
          invalidateDirectoryCache(directory);

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
        invalidateDirectoryCache(directory);
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
      const folderName =
        body.folderName ||
        body.values?.folderName ||
        ctx.action.params.values?.folderName ||
        ctx.action.params.folderName;
      if (!folderName) {
        ctx.throw(400, 'Missing folderName parameter');
        return;
      }

      // Validate folder name
      if (/[/\\<>:"|?*]/.test(folderName)) {
        ctx.throw(400, 'Invalid folder name');
        return;
      }

      const remotePath = resolveRemotePath(directory.get('rootPath'), subPath.replace(/\/$/, '') + '/' + folderName);

      try {
        await adapter.mkdir(remotePath);
        invalidateDirectoryCache(directory);
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
      if (subPath === '/') return ctx.throw(400, ctx.t('Cannot delete the mapped directory root', { ns: NAMESPACE }));
      const itemType = ctx.action.params.values?.type || ctx.action.params.type || 'file';
      if (itemType !== 'file' && itemType !== 'directory') {
        return ctx.throw(400, ctx.t('Invalid item type', { ns: NAMESPACE }));
      }
      const adapter = await getAdapter(directory);
      const remotePath = resolveRemotePath(directory.get('rootPath'), subPath);

      let entry: FileEntry;
      try {
        entry = await adapter.stat(remotePath);
      } catch {
        return ctx.throw(404, ctx.t('File or directory not found', { ns: NAMESPACE }));
      }
      if (entry.type !== itemType) {
        return ctx.throw(409, ctx.t('Requested item type does not match the stored entry', { ns: NAMESPACE }));
      }

      try {
        if (itemType === 'directory') {
          await adapter.deleteDir(remotePath);
        } else {
          await adapter.delete(remotePath);
        }
        invalidateDirectoryCache(directory);
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
      const sftpAccess = await ctx.app.acl.can({
        roles: getCurrentRoles(ctx),
        resource: 'sftpStorageConfigs',
        action: 'list',
      });

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
      if (typeof roleName !== 'string' || !roleName)
        return ctx.throw(400, ctx.t('roleName is required', { ns: NAMESPACE }));

      const result: Record<PermissionAction, DirectoryId[]> & { readOnlyActions: PermissionAction[] } = {
        view: [],
        update: [],
        destroy: [],
        readOnlyActions: [],
      };
      if (roleName === 'root') {
        result.readOnlyActions = [...PERMISSION_ACTIONS];
        ctx.body = result;
        return;
      }
      const resource = await ctx.db.getRepository('dataSourcesRolesResources').findOne({
        filter: { roleName, dataSourceKey: 'main', name: 'externalStorageDirectories' },
      });
      if (!resource) {
        const legacyResource = await ctx.db.getRepository('rolesResources').findOne({
          filter: { roleName, name: 'externalStorageDirectories' },
        });
        if (legacyResource || hasInheritedDirectoryPermissions(ctx, roleName)) {
          result.readOnlyActions = [...PERMISSION_ACTIONS];
        }
        ctx.body = result;
        return;
      }
      if (getRecordValue(resource, 'usingActionsConfig') === false) {
        result.readOnlyActions = [...PERMISSION_ACTIONS];
        ctx.body = result;
        return;
      }

      const actions = await ctx.db.getRepository('dataSourcesRolesResourcesActions').find({
        filter: { rolesResourceId: getRecordValue(resource, 'id') },
        appends: ['scope'],
      });
      const seen = new Set<PermissionAction>();
      for (const action of actions) {
        const actionName = getRecordValue(action, 'name');
        if (!PERMISSION_ACTIONS.includes(actionName)) continue;
        const ids = getManagedActionIds(action);
        if (ids === null || seen.has(actionName)) {
          if (!result.readOnlyActions.includes(actionName)) result.readOnlyActions.push(actionName);
          result[actionName] = [];
        } else if (!result.readOnlyActions.includes(actionName)) {
          result[actionName] = ids;
        }
        seen.add(actionName);
      }
      ctx.body = result;
    },

    /** Update only supplied, losslessly representable directory ID scopes. */
    updateRolePermissions: async (ctx: any) => {
      const currentRoles = getCurrentRoles(ctx);
      if (!currentRoles.includes('root')) {
        const canAccessRoles = await ctx.app.acl.can({ roles: currentRoles, resource: 'roles', action: 'update' });
        if (!canAccessRoles) return ctx.throw(403, 'Permission denied');
      }

      const payload = ctx.action.params.values || ctx.request.body || {};
      const roleName = payload.roleName || ctx.action.params.roleName;
      const permissions: unknown = payload.values;
      if (typeof roleName !== 'string' || !roleName)
        return ctx.throw(400, ctx.t('roleName is required', { ns: NAMESPACE }));
      if (roleName === 'root')
        return ctx.throw(409, ctx.t('Root permissions cannot be edited here', { ns: NAMESPACE }));
      if (!isRecord(permissions)) {
        return ctx.throw(400, ctx.t('values must contain permission actions', { ns: NAMESPACE }));
      }
      const actionNames = Object.keys(permissions);
      if (!actionNames.length || actionNames.some((name) => !PERMISSION_ACTIONS.includes(name as PermissionAction))) {
        return ctx.throw(400, ctx.t('Invalid permission actions', { ns: NAMESPACE }));
      }
      for (const actionName of actionNames) {
        const ids = permissions[actionName];
        if (!Array.isArray(ids) || !ids.every(isDirectoryId)) {
          return ctx.throw(400, ctx.t('Invalid directory IDs', { ns: NAMESPACE }));
        }
      }

      const resourceRepo = ctx.db.getRepository('dataSourcesRolesResources');
      const actionsRepo = ctx.db.getRepository('dataSourcesRolesResourcesActions');
      const scopeRepo = ctx.db.getRepository('dataSourcesRolesResourcesScopes');
      const resource = await ctx.db.sequelize.transaction(async (transaction) => {
        // Serialise plugin updates for this role even before the resource row exists.
        const role = await ctx.db.getRepository('roles').findOne({
          filterByTk: roleName,
          transaction,
          lock: true,
        });
        if (!role) return ctx.throw(404, ctx.t('Role not found', { ns: NAMESPACE }));

        let resource = await resourceRepo.findOne({
          filter: { roleName, dataSourceKey: 'main', name: 'externalStorageDirectories' },
          transaction,
          lock: true,
        });
        const legacyResource = !resource
          ? await ctx.db.getRepository('rolesResources').findOne({
              filter: { roleName, name: 'externalStorageDirectories' },
              transaction,
            })
          : null;
        if (
          (!resource && (legacyResource || hasInheritedDirectoryPermissions(ctx, roleName))) ||
          (resource && getRecordValue(resource, 'usingActionsConfig') === false)
        ) {
          return ctx.throw(409, ctx.t('Inherited permissions cannot be edited here', { ns: NAMESPACE }));
        }

        const existingActions = resource
          ? await actionsRepo.find({
              filter: { rolesResourceId: getRecordValue(resource, 'id') },
              appends: ['scope'],
              transaction,
            })
          : [];
        for (const actionName of actionNames) {
          const matching = existingActions.filter((action) => getRecordValue(action, 'name') === actionName);
          if (matching.length > 1 || (matching.length === 1 && getManagedActionIds(matching[0]) === null)) {
            return ctx.throw(409, ctx.t('This permission uses an advanced data scope', { ns: NAMESPACE }));
          }
        }

        if (!resource && actionNames.every((name) => (permissions[name] as DirectoryId[]).length === 0)) return null;
        const dataSourceRoles = ctx.db.getRepository('dataSourcesRoles');
        const dataSourceRole = await dataSourceRoles.findOne({
          filter: { roleName, dataSourceKey: 'main' },
          transaction,
          lock: true,
        });
        if (!dataSourceRole) {
          await dataSourceRoles.create({
            values: { id: uid(), roleName, dataSourceKey: 'main', strategy: getRecordValue(role, 'strategy') },
            transaction,
            hooks: false,
          });
        }
        if (!resource) {
          resource = await resourceRepo.create({
            values: {
              id: ctx.app.snowflakeIdGenerator.generate(),
              roleName,
              dataSourceKey: 'main',
              name: 'externalStorageDirectories',
              usingActionsConfig: true,
            },
            transaction,
            hooks: false,
          });
        }

        for (const actionName of actionNames) {
          const ids = permissions[actionName] as DirectoryId[];
          const action = existingActions.find((item) => getRecordValue(item, 'name') === actionName);
          if (!action && ids.length === 0) continue;

          // A scope can be shared by other actions or roles: never mutate it in place.
          const scope = await scopeRepo.create({
            values: {
              dataSourceKey: 'main',
              resourceName: 'externalStorageDirectories',
              scope: { $and: [{ id: { $in: ids } }] },
            },
            transaction,
          });
          if (action) {
            await action.update({ scopeId: getRecordValue(scope, 'id') }, { transaction, hooks: false });
          } else {
            await actionsRepo.create({
              values: {
                rolesResourceId: getRecordValue(resource, 'id'),
                name: actionName,
                scopeId: getRecordValue(scope, 'id'),
              },
              transaction,
            });
          }
        }
        return resource;
      });

      if (resource) {
        const dataSourcePlugin = ctx.app.pm?.get('data-source-manager');
        try {
          await resource.writeToACL({ acl: ctx.app.acl });
        } catch (error) {
          // A failed refresh must not leave a revoked permission active in this process.
          const role = ctx.app.acl.getRole(roleName);
          if (role) {
            if (!role.getResource('externalStorageDirectories')) {
              role.grantAction('externalStorageDirectories:view', {});
            }
            const cachedResource = role.getResource('externalStorageDirectories');
            for (const actionName of Object.keys(cachedResource.getActions())) cachedResource.removeAction(actionName);
          }
          throw error;
        } finally {
          if (dataSourcePlugin) {
            await dataSourcePlugin.sendSyncMessage({
              type: 'syncRoleResource',
              roleName,
              dataSourceKey: 'main',
              resourceName: 'externalStorageDirectories',
            });
          }
        }
      }
      ctx.body = { data: 'ok' };
    },
  };
}
