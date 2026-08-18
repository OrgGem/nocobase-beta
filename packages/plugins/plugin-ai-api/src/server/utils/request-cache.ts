/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context } from '@nocobase/actions';
import type { Model } from '@nocobase/database';
import { resolveUserGroup, type AiApiUsageGroup } from '../quota-groups';

interface AiApiRequestCache {
  configLoaded: boolean;
  config: Model | null;
  groupKey?: string;
  group?: AiApiUsageGroup;
}

function getCache(ctx: Context): AiApiRequestCache {
  if (!ctx.state.aiApiRequestCache) {
    ctx.state.aiApiRequestCache = { configLoaded: false, config: null };
  }
  return ctx.state.aiApiRequestCache;
}

/**
 * Returns the aiApiConfig row, reading it at most once per request. The same row
 * is consulted by the body limit, mode resolution, model whitelist, quota and
 * billing steps of a single gateway request, so caching it on ctx.state removes
 * several duplicate queries per request.
 */
export async function getAiApiConfig(ctx: Context): Promise<Model | null> {
  const cache = getCache(ctx);
  if (!cache.configLoaded) {
    cache.config = (await ctx.db.getRepository('aiApiConfig').findOne()) ?? null;
    cache.configLoaded = true;
  }
  return cache.config;
}

/**
 * Returns the caller's usage group, resolving it at most once per request per
 * user id. Wraps resolveUserGroup, which otherwise runs membership queries on
 * every call site (rate limiting, permissions, billing, context overflow).
 */
export async function resolveRequestUserGroup(
  ctx: Context,
  userId: string | number | bigint | undefined | null,
): Promise<AiApiUsageGroup> {
  const cache = getCache(ctx);
  const groupKey = userId === undefined || userId === null ? '' : String(userId);
  if (!cache.group || cache.groupKey !== groupKey) {
    cache.group = await resolveUserGroup(ctx, userId);
    cache.groupKey = groupKey;
  }
  return cache.group;
}
