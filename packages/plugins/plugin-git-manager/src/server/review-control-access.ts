/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context } from '@nocobase/actions';

const CONTROL_COLLECTIONS = new Set(['gitReviewProjects', 'gitReviewInbox', 'gitReviewRequests', 'gitReviewCutover']);
const REVIEW_COLLECTION = new Set(['gitCodeReviews']);
const ROUTE_KEYS = new Set([
  'resourceName',
  'targetCollection',
  'associatedName',
  '__collection',
  'appends',
  'include',
  'fields',
]);

function containsCollection(value: unknown, collections = CONTROL_COLLECTIONS): boolean {
  if (typeof value === 'string') return value.split(/[.[\],:/()=\s]+/).some((part) => collections.has(part));
  if (Array.isArray(value)) return value.some((item) => containsCollection(item, collections));
  if (value && typeof value === 'object')
    return Object.entries(value).some(
      ([key, nested]) => containsCollection(key, collections) || containsCollection(nested, collections),
    );
  return false;
}

function containsRouteOverride(value: unknown, collections = CONTROL_COLLECTIONS): boolean {
  if (Array.isArray(value)) return value.some((item) => containsRouteOverride(item, collections));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, nested]) => {
    const keyParts = key.split(/[.[\],:/()=\s]+/);
    return (
      (keyParts.some((part) => ROUTE_KEYS.has(part)) && containsCollection(nested, collections)) ||
      containsRouteOverride(nested, collections)
    );
  });
}

export async function enforceReviewControlAccess(ctx: Context, next: () => Promise<void>): Promise<void> {
  let currentTarget: string | undefined;
  try {
    const current = ctx.getCurrentRepository?.();
    currentTarget = current?.targetCollection?.name || current?.collection?.name;
  } catch {
    // Custom actions need not have a backing collection.
  }
  if (
    containsCollection(ctx.action?.resourceName) ||
    containsCollection(currentTarget) ||
    [ctx.action?.params, ctx.request?.body, ctx.query, ctx.request?.query].some((input) => containsRouteOverride(input))
  )
    ctx.throw(403, 'Permission denied');
  if (
    ctx.action?.actionName &&
    !['list', 'get'].includes(ctx.action.actionName) &&
    (containsCollection(ctx.action.resourceName, REVIEW_COLLECTION) ||
      containsCollection(currentTarget, REVIEW_COLLECTION) ||
      [ctx.action.params, ctx.request?.body, ctx.query, ctx.request?.query].some((input) =>
        containsRouteOverride(input, REVIEW_COLLECTION),
      ))
  )
    ctx.throw(403, 'Permission denied');
  await next();
}
