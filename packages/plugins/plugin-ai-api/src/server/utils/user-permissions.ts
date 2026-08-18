/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Context } from '@nocobase/actions';
import { toOpenAIError } from './openai-format';
import { resolveRequestUserGroup } from './request-cache';
import type { AiApiUsageGroup } from '../quota-groups';

const SCOPE_TTL_MS = 15_000;

interface CachedScope {
  scope: AiApiAccessScope;
  expiresAt: number;
}

const scopeCache = new Map<string, CachedScope>();

/**
 * Resolved LLM access of a user's usage group, layered *under* the global
 * `aiApiConfig.enabledLlmServices` whitelist. Group settings can only ever narrow global
 * access, never widen it. Empty lists on the group mean "no narrowing" — the group inherits
 * the full global configuration, so the default group never locks everyone out.
 */
export interface AiApiAccessScope {
  /** The group whose settings produced this scope. */
  groupId?: string | number | bigint;
  /** Empty means no narrowing; non-empty restricts to these services. */
  allowedServices: string[];
  allowAllModels: boolean;
  allowedModels: Set<string>;
  /**
   * True when the lookup itself failed. Distinct from an open scope — "this user has no
   * restrictions" and "we cannot tell whether this user has restrictions" must not be
   * conflated, or a mid-rolling-upgrade missing table silently lifts every user's restrictions.
   */
  lookupFailed: boolean;
}

const OPEN_SCOPE: AiApiAccessScope = {
  allowedServices: [],
  allowAllModels: true,
  allowedModels: new Set(),
  lookupFailed: false,
};

const LOOKUP_FAILED_SCOPE: AiApiAccessScope = { ...OPEN_SCOPE, lookupFailed: true };

/**
 * Invalidate cached scopes for one group across every app in this process, or all groups
 * when called with no argument. Keys are `${appName}:group:${groupId}`.
 *
 * Per-process only: in a multi-node deployment other nodes keep serving their cached scope
 * until the 15s TTL expires or the sync message arrives.
 */
export function invalidateGroupAccessCache(groupId?: string | number | bigint): void {
  if (groupId === undefined || groupId === null) {
    scopeCache.clear();
    return;
  }
  const suffix = `:group:${groupId}`;
  for (const key of scopeCache.keys()) {
    if (key.endsWith(suffix)) scopeCache.delete(key);
  }
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

/** Build a scope from a usage group. Empty lists mean no narrowing. */
export function buildAccessScope(group: AiApiUsageGroup): AiApiAccessScope {
  return {
    groupId: group.id,
    allowedServices: toStringArray(group.allowedLlmServices),
    allowAllModels: group.allowAllModels !== false,
    allowedModels: new Set(toStringArray(group.allowedModels)),
    lookupFailed: false,
  };
}

/**
 * Load the access scope of the current user's usage group, cached for 15s per group id —
 * the same TTL the role permission cache uses. Membership is resolved live on every request
 * and memoized for its duration (one indexed query even though several call sites ask), so
 * moving a user between groups needs no invalidation; group edits are invalidated by the
 * afterSave/afterDestroy hooks in plugin.ts.
 */
export async function resolveUserAccessScope(ctx: Context): Promise<AiApiAccessScope> {
  const userId = ctx.state.currentUser?.id;

  let group: AiApiUsageGroup;
  try {
    group = await resolveRequestUserGroup(ctx, userId);
  } catch (err) {
    // Fail closed. A failed lookup cannot be treated as "no restrictions": during a rolling
    // upgrade the tables may not exist yet, and that must not lift every user's restrictions.
    ctx.log?.error?.('AI API group access lookup failed, denying access:', err);
    return LOOKUP_FAILED_SCOPE;
  }

  const key = `${ctx.app?.name ?? 'main'}:group:${group.id}`;
  const cached = scopeCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.scope;

  const scope = buildAccessScope(group);
  scopeCache.set(key, { scope, expiresAt: Date.now() + SCOPE_TTL_MS });
  return scope;
}

function matchesService(list: string[], serviceName?: string, serviceTitle?: string): boolean {
  return list.some((entry) => entry === serviceName || entry === serviceTitle);
}

/**
 * Effective service check: the global whitelist AND the group settings must both allow it.
 *
 * An empty global whitelist means "expose all services", preserving existing behaviour.
 * An empty group list means "no narrowing" — the group inherits the global configuration.
 */
export function isServiceAllowed(
  scope: AiApiAccessScope,
  globalEnabledServices: unknown,
  service: { name?: string; title?: string },
): boolean {
  if (scope.lookupFailed) return false;
  const globalList = toStringArray(globalEnabledServices);
  if (globalList.length && !matchesService(globalList, service.name, service.title)) return false;
  if (!scope.allowedServices.length) return true;
  return matchesService(scope.allowedServices, service.name, service.title);
}

/** Model-level narrowing on top of isServiceAllowed, keyed by "serviceName/modelId". */
export function isModelAllowed(scope: AiApiAccessScope, fullModelId: string): boolean {
  if (scope.lookupFailed) return false;
  if (scope.allowAllModels) return true;
  return scope.allowedModels.has(fullModelId);
}

/**
 * Gate a completion/embedding request on the caller's effective service+model access.
 *
 * Writes a 403 in OpenAI error shape and returns false when access is denied, so callers
 * can `if (!(await enforceModelAccess(...))) return;`.
 */
export async function enforceModelAccess(
  ctx: Context,
  globalEnabledServices: unknown,
  service: { name?: string; title?: string },
  modelId: string,
): Promise<boolean> {
  const scope = await resolveUserAccessScope(ctx);
  const serviceLabel = service.title || service.name;

  // The denial is ours, not the caller's — report it as retryable rather than as a permission
  // decision, so clients back off instead of treating the grant as permanently revoked.
  if (scope.lookupFailed) {
    ctx.status = 503;
    ctx.body = toOpenAIError(
      503,
      'Unable to verify LLM permissions for this user. Please retry shortly.',
      'service_unavailable',
      'permission_check_failed',
    );
    return false;
  }

  if (!isServiceAllowed(scope, globalEnabledServices, service)) {
    ctx.status = 403;
    ctx.body = toOpenAIError(
      403,
      `LLM service '${serviceLabel}' is not enabled for API access`,
      'permission_denied',
      'model_not_available',
    );
    return false;
  }

  if (!isModelAllowed(scope, `${service.name}/${modelId}`)) {
    ctx.status = 403;
    ctx.body = toOpenAIError(
      403,
      `Model '${service.name}/${modelId}' is not permitted for this user. ` +
        `Use GET /v1/models to see available models.`,
      'permission_denied',
      'model_not_available',
    );
    return false;
  }

  return true;
}
