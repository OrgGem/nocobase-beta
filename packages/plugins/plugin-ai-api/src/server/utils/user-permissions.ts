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

const SCOPE_TTL_MS = 15_000;

interface CachedScope {
  scope: AiApiAccessScope;
  expiresAt: number;
}

const scopeCache = new Map<string, CachedScope>();

/**
 * Resolved per-user LLM access, layered *under* the global `aiApiConfig.enabledLlmServices`
 * whitelist. A user grant can only ever narrow global access, never widen it.
 */
export interface AiApiAccessScope {
  /** False when the user has no aiApiUserPermissions row — global config alone decides. */
  hasUserRecord: boolean;
  /** True when a row exists but is switched off, denying every service. */
  denyAll: boolean;
  /** null means "no user-level narrowing"; an empty array denies every service. */
  allowedServices: string[] | null;
  allowAllModels: boolean;
  allowedModels: Set<string>;
  /**
   * True when the lookup itself failed. Distinct from hasUserRecord:false — "this user has no
   * restrictions" and "we cannot tell whether this user has restrictions" must not be conflated,
   * or a mid-rolling-upgrade missing table silently lifts every user's restrictions.
   */
  lookupFailed: boolean;
}

const NO_RECORD_SCOPE: AiApiAccessScope = {
  hasUserRecord: false,
  denyAll: false,
  allowedServices: null,
  allowAllModels: true,
  allowedModels: new Set(),
  lookupFailed: false,
};

const LOOKUP_FAILED_SCOPE: AiApiAccessScope = { ...NO_RECORD_SCOPE, denyAll: true, lookupFailed: true };

/**
 * Invalidate cached scopes for one user across every app in this process, or all users when
 * called with no argument. Keys are `${appName}:${userId}`, and the afterSave hook only knows
 * the user id, so the match is on the suffix.
 *
 * This is per-process only: in a multi-node deployment other nodes keep serving their cached
 * scope until the 15s TTL expires.
 */
export function invalidateUserPermissionCache(userId?: string | number | bigint): void {
  if (userId === undefined || userId === null) {
    scopeCache.clear();
    return;
  }
  const suffix = `:${userId}`;
  for (const key of scopeCache.keys()) {
    if (key.endsWith(suffix)) scopeCache.delete(key);
  }
}

/**
 * Sequelize instances expose columns through .get() only — a plain property read returns
 * undefined for most fields. Mirrors valueOf() in billing.ts so plain-object test fixtures
 * work too.
 */
function valueOf<T>(row: unknown, name: string): T {
  if (!row) return undefined as T;
  const candidate = row as { get?: (key: string) => unknown };
  if (typeof candidate.get === 'function') return candidate.get(name) as T;
  return (row as Record<string, unknown>)[name] as T;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

/** Build a scope from an aiApiUserPermissions row (or absence of one). */
export function buildAccessScope(row: unknown): AiApiAccessScope {
  if (!row) return NO_RECORD_SCOPE;
  if (valueOf<boolean>(row, 'enabled') === false) {
    return { ...NO_RECORD_SCOPE, hasUserRecord: true, denyAll: true, allowedServices: [] };
  }
  return {
    hasUserRecord: true,
    denyAll: false,
    allowedServices: toStringArray(valueOf(row, 'allowedLlmServices')),
    allowAllModels: valueOf<boolean>(row, 'allowAllModels') !== false,
    allowedModels: new Set(toStringArray(valueOf(row, 'allowedModels'))),
    lookupFailed: false,
  };
}

/**
 * Load the current user's access scope, cached for 15s per user id — the same TTL the role
 * permission cache uses. Invalidated by afterSave/afterDestroy hooks in plugin.ts.
 */
export async function resolveUserAccessScope(ctx: Context): Promise<AiApiAccessScope> {
  const userId = ctx.state.currentUser?.id;
  if (userId === undefined || userId === null) return NO_RECORD_SCOPE;

  // Sub-apps share this process but have separate databases, so user id 1 in one app is a
  // different person than user id 1 in another. Without the app prefix they collide here.
  const key = `${ctx.app?.name ?? 'main'}:${userId}`;
  const cached = scopeCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.scope;

  let scope: AiApiAccessScope;
  try {
    const row = await ctx.db.getRepository('aiApiUserPermissions').findOne({ filter: { userId } });
    scope = buildAccessScope(row);
  } catch (err) {
    // Fail closed. A failed lookup cannot be treated as "no restrictions": during a rolling
    // upgrade the table may not exist yet, and that must not lift every user's restrictions.
    ctx.log?.error?.('AI API user permissions lookup failed, denying access:', err);
    return LOOKUP_FAILED_SCOPE;
  }

  scopeCache.set(key, { scope, expiresAt: Date.now() + SCOPE_TTL_MS });
  return scope;
}

function matchesService(list: string[], serviceName?: string, serviceTitle?: string): boolean {
  return list.some((entry) => entry === serviceName || entry === serviceTitle);
}

/**
 * Effective service check: the global whitelist AND the user grant must both allow it.
 *
 * An empty global whitelist means "expose all services", preserving existing behaviour.
 * An empty user grant means "deny everything" — the record itself is the opt-in.
 */
export function isServiceAllowed(
  scope: AiApiAccessScope,
  globalEnabledServices: unknown,
  service: { name?: string; title?: string },
): boolean {
  // denyAll is checked before hasUserRecord: a failed lookup denies without having a record.
  if (scope.denyAll) return false;
  const globalList = toStringArray(globalEnabledServices);
  if (globalList.length && !matchesService(globalList, service.name, service.title)) return false;
  if (!scope.hasUserRecord) return true;
  return matchesService(scope.allowedServices ?? [], service.name, service.title);
}

/** Model-level narrowing on top of isServiceAllowed, keyed by "serviceName/modelId". */
export function isModelAllowed(scope: AiApiAccessScope, fullModelId: string): boolean {
  if (scope.denyAll) return false;
  if (!scope.hasUserRecord) return true;
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
