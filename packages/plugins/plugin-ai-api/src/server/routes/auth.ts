/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Context } from '@nocobase/actions';
import { toOpenAIError } from '../utils/openai-format';

/**
 * Authentication middleware for /api/ai-llm/v1/* routes.
 *
 * Resolve the principal prepared by NocoBase auth/ACL middleware. OIDC resource
 * authentication rewrites the external access token to an internal session token
 * and sets currentUser before this gateway runs. API keys are the one case where
 * we still need to decode the token locally because they are signed directly by
 * NocoBase and carry a fixed roleName.
 */
export async function authenticateBearer(ctx: Context): Promise<boolean> {
  const authHeader = ctx.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    ctx.status = 401;
    ctx.body = toOpenAIError(
      401,
      'Missing or invalid Authorization header. Expected: Bearer <access-token>',
      'invalid_request_error',
      'invalid_api_key',
    );
    return false;
  }

  const token = authHeader.substring(7).trim();
  if (!token) {
    ctx.status = 401;
    ctx.body = toOpenAIError(401, 'API key is empty', 'invalid_request_error', 'invalid_api_key');
    return false;
  }

  try {
    if (ctx.state.currentUser) {
      ctx.state.aiApiAuthType = ctx.state.oauthPrincipal ? 'oidc' : 'bearer';
      if (!ctx.state.currentRole) {
        const requestedRole = ctx.get('X-Role');
        const rolesRepository = ctx.db.getRepository('users.roles', ctx.state.currentUser.id);
        const roles = await rolesRepository.find({ fields: ['name'] });
        const roleNames = roles.map((role: { name: string }) => role.name);
        // An explicit X-Role that the user does not hold must be rejected, not
        // silently downgraded to the first role — otherwise a caller could probe
        // for access under a role they were never granted.
        if (requestedRole && !roleNames.includes(requestedRole)) {
          ctx.status = 403;
          ctx.body = toOpenAIError(
            403,
            `Requested role '${requestedRole}' is not assigned to this user`,
            'permission_denied',
            'role_not_permitted',
          );
          return false;
        }
        ctx.state.currentRole = requestedRole || roleNames[0];
        ctx.state.currentRoles = ctx.state.currentRole ? [ctx.state.currentRole] : roleNames;
      }
      return true;
    }

    // Try to authenticate using the token as a NocoBase JWT/API token
    // NocoBase API keys are essentially JWT tokens signed with the app secret
    const jwt = ctx.app['authManager']?.jwt;
    if (!jwt) {
      ctx.status = 500;
      ctx.body = toOpenAIError(500, 'JWT system not available', 'server_error');
      return false;
    }

    let decoded: { userId?: string | number; roleName?: string; temp?: boolean };
    try {
      decoded = await jwt.decode(token);
    } catch (e) {
      ctx.status = 401;
      ctx.body = toOpenAIError(401, 'Incorrect API key provided', 'invalid_request_error', 'invalid_api_key');
      return false;
    }

    if (!decoded || !decoded.userId) {
      ctx.status = 401;
      ctx.body = toOpenAIError(401, 'Invalid or expired API key', 'invalid_request_error', 'invalid_api_key');
      return false;
    }

    // This fallback is for API keys only. A normal login/OIDC token should have
    // been resolved by NocoBase auth middleware and must not be treated as the
    // member role merely because it has no roleName claim.
    if (!decoded.roleName) {
      ctx.status = 401;
      ctx.body = toOpenAIError(
        401,
        'Token was not resolved by the NocoBase auth middleware',
        'invalid_request_error',
        'invalid_api_key',
      );
      return false;
    }

    const user = await ctx.db.getRepository('users').findOne({
      filterByTk: decoded.userId,
    });

    if (!user) {
      ctx.status = 401;
      ctx.body = toOpenAIError(401, 'User not found for this API key', 'invalid_request_error', 'invalid_api_key');
      return false;
    }

    // Set user context for downstream handlers
    ctx.state.currentUser = user;
    const rolesRepository = ctx.db.getRepository('users.roles', user.id);
    const roles = await rolesRepository.find({ fields: ['name'] });
    const roleNames = roles.map((role: { name: string }) => role.name);
    if (!roleNames.includes(decoded.roleName)) {
      ctx.status = 403;
      ctx.body = toOpenAIError(
        403,
        'The API key role is no longer assigned to this user',
        'permission_denied',
        'role_not_permitted',
      );
      return false;
    }
    ctx.state.currentRole = decoded.roleName;
    ctx.state.currentRoles = [decoded.roleName];
    ctx.state.aiApiAuthType = 'apiKey';

    // Also set ctx.auth for AIEmployee compatibility.
    // Only expose non-sensitive fields — exclude password, token, 2FA secrets, etc.
    if (!ctx.auth) {
      (ctx as any).auth = {};
    }
    const SAFE_USER_FIELDS = new Set(['id', 'username', 'nickname', 'email', 'createdAt', 'updatedAt']);
    const rawUser = user.toJSON?.() ?? {};
    const safeUser: Record<string, any> = { id: user.id };
    for (const field of SAFE_USER_FIELDS) {
      if (rawUser[field] !== undefined) safeUser[field] = rawUser[field];
    }
    (ctx as any).auth.user = safeUser;

    return true;
  } catch (err) {
    ctx.log.error('AI API auth error:', err);
    ctx.status = 401;
    ctx.body = toOpenAIError(401, 'Authentication failed', 'invalid_request_error', 'invalid_api_key');
    return false;
  }
}
