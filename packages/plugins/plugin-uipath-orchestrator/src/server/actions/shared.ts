/**
 * Shared action utilities
 */

import type { Context } from '@nocobase/actions';
import type { FolderContext } from '../services/types';

export function handleError(ctx: Context, error: any) {
  const message = error?.message || 'Unknown error';
  ctx.status = 400;
  ctx.body = { errors: [{ message }] };
}

/**
 * Extract folder context from action params.
 * Client sends folderId/folderKey/folderPath as top-level params.
 */
export function extractFolderContext(params: any): FolderContext | undefined {
  const { folderId, folderKey, folderPath } = params;
  const hasFolderOverride =
    Object.prototype.hasOwnProperty.call(params, 'folderId') ||
    Object.prototype.hasOwnProperty.call(params, 'folderKey') ||
    Object.prototype.hasOwnProperty.call(params, 'folderPath');

  if (!hasFolderOverride) {
    return undefined;
  }

  return {
    folderId: folderId === undefined || folderId === null || folderId === '' ? undefined : Number(folderId),
    folderKey: folderKey || undefined,
    folderPath: folderPath || undefined,
  };
}

/**
 * Extract OData-compatible filter from action params.
 */
export function extractODataFilter(params: any): Record<string, any> {
  const query: Record<string, any> = {};

  if (params.top) query.$top = Number(params.top);
  if (params.skip) query.$skip = Number(params.skip);
  if (params.filter) query.$filter = params.filter;
  if (params.select) query.$select = params.select;
  if (params.expand) query.$expand = params.expand;
  if (params.orderby) query.$orderby = params.orderby;
  if (params.count !== undefined) query.$count = params.count === 'true' || params.count === true;

  // Sensible defaults
  if (!query.$top) query.$top = 50;

  return query;
}
