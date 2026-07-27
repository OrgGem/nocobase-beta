/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { AsyncLocalStorage } from 'async_hooks';

export type KnowledgeBaseRequestContext = {
  userId?: number | string;
  userRoles?: string[];
  ctx?: unknown;
  agentUsername?: string;
};

/**
 * Simple request context storage.
 * Stores the current user ID and roles from Koa middleware so that
 * vector store search can filter by userId/roles without needing
 * plugin-ai to pass it explicitly.
 */
const requestContext = new AsyncLocalStorage<KnowledgeBaseRequestContext>();

export function getCurrentUserId(): number | string | undefined {
  return requestContext.getStore()?.userId;
}

export function getCurrentUserRoles(): string[] {
  return requestContext.getStore()?.userRoles ?? [];
}

export function getCurrentRequestContext(): KnowledgeBaseRequestContext | undefined {
  return requestContext.getStore();
}

export function runWithUserId<T>(userId: number | string | undefined, fn: () => T): T {
  const current = requestContext.getStore() ?? {};
  return requestContext.run({ ...current, userId }, fn);
}

export function runWithAgentUsername<T>(agentUsername: string, fn: () => T): T {
  const current = requestContext.getStore() ?? {};
  return requestContext.run({ ...current, agentUsername }, fn);
}

export default requestContext;
