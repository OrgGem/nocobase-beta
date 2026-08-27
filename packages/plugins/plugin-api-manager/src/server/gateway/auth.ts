import type { Application } from '@nocobase/server';
import type { Database } from '@nocobase/database';
import { ERROR_CODES, type RouteDirection } from '../../constants';
import { hashApiKey } from '../services/key-manager';
import { ApimError } from '../services/errors';

export interface AuthResult {
  /** Plugin API-key row id; null when authenticated via an app Bearer token. */
  apiKeyId: number | null;
  partnerId: number | null;
  scopes: string[];
  /** Role carried by the app token (Bearer); always null for plugin API keys. */
  roleName: string | null;
  /** User authenticated by the app token; null for plugin API keys. */
  userId: number | null;
  /** True when authenticated via a NocoBase app JWT (Bearer), false for plugin API keys. */
  viaAppToken?: boolean;
}

function hasScope(scopes: string[], direction: RouteDirection, routeName: string): boolean {
  return scopes.some((scope) => scope === direction || scope === `${direction}:${routeName}`);
}

export async function authenticateApiKey(
  db: Database,
  apiKeyHeader: string | undefined,
  direction: RouteDirection,
  routeName: string,
): Promise<AuthResult> {
  const presented = (apiKeyHeader ?? '').trim();
  if (!presented) {
    throw new ApimError(ERROR_CODES.UNAUTHORIZED, 'Missing X-API-Key header', 401);
  }

  const repo = db.getRepository('apiManagerApiKeys');
  const record = await repo.findOne({ filter: { keyHash: hashApiKey(presented), enabled: true } });
  if (!record) {
    throw new ApimError(ERROR_CODES.UNAUTHORIZED, 'Invalid API key', 401);
  }

  const expiresAt = record.get('expiresAt');
  if (expiresAt && new Date(expiresAt as string | Date).getTime() < Date.now()) {
    throw new ApimError(ERROR_CODES.UNAUTHORIZED, 'API key has expired', 401);
  }

  const revokedAt = record.get('revokedAt');
  if (revokedAt) {
    throw new ApimError(ERROR_CODES.UNAUTHORIZED, 'API key has been revoked', 401);
  }

  const rawScopes = record.get('scopes');
  const scopes: string[] = Array.isArray(rawScopes) ? rawScopes.map((s) => String(s)) : [];
  if (!hasScope(scopes, direction, routeName)) {
    throw new ApimError(ERROR_CODES.FORBIDDEN, `API key is not authorized for this ${direction} route`, 403);
  }

  const apiKeyId = Number(record.get('id'));
  const partnerIdValue = record.get('partnerId');
  const partnerId = partnerIdValue == null ? null : Number(partnerIdValue);

  try {
    await repo.update({ filterByTk: apiKeyId, values: { lastUsedAt: new Date() } });
  } catch {
    // lastUsedAt is best-effort; never fail auth because of it.
  }

  return { apiKeyId, partnerId, scopes, roleName: null, userId: null };
}

/**
 * Authenticate a NocoBase app Bearer token (JWT) against the gateway.
 *
 * The gateway runs before the core auth middleware, so the app JWT has not
 * been verified yet. We verify it here with the app's authManager.jwt service
 * (same secret as login sessions and plugin-api-keys tokens), then enforce the
 * same role ACL (apimRoutes:call:<routeName>) the plugin API keys use.
 *
 * Scope checks (inbound/outbound:<route>) do NOT apply to app tokens: access is
 * controlled purely by the role ACL. This lets a user call a route with their
 * login token (or an app API key with the same role) instead of minting a
 * plugin API key. Routes must set authMode to 'role' or 'both' to accept
 * app tokens.
 */
export async function authenticateBearerToken(app: Application, db: Database, bearerToken: string | undefined): Promise<AuthResult> {
  // Fast path: no token supplied — avoid paying the JWT decode cost on the
  // gateway hot path (this runs before the core auth middleware for every
  // request, including unauthenticated ones). The router already guarantees
  // this is only called when a Bearer credential is expected (authMode
  // 'role'/'both' and no X-API-Key), so a missing token is always a 401.
  const token = (bearerToken ?? '').trim();
  if (!token) {
    throw new ApimError(ERROR_CODES.UNAUTHORIZED, 'Missing Bearer token', 401);
  }
  let payload: { userId?: number | string; roleName?: string; temp?: boolean; jti?: string };
  try {
    payload = await app.authManager.jwt.decode(token);
  } catch {
    throw new ApimError(ERROR_CODES.UNAUTHORIZED, 'Invalid or expired app token', 401);
  }
  // Honor the app token blacklist (logout / password change), mirroring the
  // core Auth.checkToken() flow. The blacklist service is registered by
  // plugin-auth; without it there is nothing to check.
  const blacklist = app.authManager.jwt.blacklist;
  if (blacklist) {
    try {
      const blocked = await blacklist.has(payload.jti ?? token);
      if (blocked) {
        throw new ApimError(ERROR_CODES.UNAUTHORIZED, 'App token has been blocked', 401);
      }
    } catch (error) {
      if (error instanceof ApimError) throw error;
      // Blacklist lookup failure must not fail open: reject the request.
      throw new ApimError(ERROR_CODES.UNAUTHORIZED, 'App token could not be validated', 401);
    }
  }
  const userIdValue = payload.userId;
  if (userIdValue == null) {
    throw new ApimError(ERROR_CODES.UNAUTHORIZED, 'App token does not carry a user', 401);
  }
  const userId = Number(userIdValue);
  if (!Number.isFinite(userId) || userId <= 0) {
    throw new ApimError(ERROR_CODES.UNAUTHORIZED, 'App token carries an invalid user', 401);
  }
  // The token signature is valid, but the user may have been deleted since it
  // was minted — verify the user still exists.
  const user = await db.getRepository('users').findOne({ filter: { id: userId } });
  if (!user) {
    throw new ApimError(ERROR_CODES.UNAUTHORIZED, 'App token carries a user that no longer exists', 401);
  }
  const roleNameValue = payload.roleName;
  const roleName = roleNameValue == null || roleNameValue === '' ? null : String(roleNameValue);
  if (!roleName) {
    throw new ApimError(ERROR_CODES.FORBIDDEN, 'App token does not carry a role', 403);
  }
  const partnerId = await resolveRolePartner(db, roleName);
  return { apiKeyId: null, partnerId, scopes: [], roleName, userId, viaAppToken: true };
}



/**
 * Resolve the partner a NocoBase role belongs to via apiPartnerRoles.
 * Returns null when the role is not bound to any partner.
 */
export async function resolveRolePartner(db: Database, roleName: string): Promise<number | null> {
  const repo = db.getRepository('apiPartnerRoles');
  if (!repo) {
    return null;
  }
  const binding = await repo.findOne({ filter: { roleName } });
  if (!binding) {
    return null;
  }
  const partnerId = binding.get('partnerId');
  return partnerId == null ? null : Number(partnerId);
}
