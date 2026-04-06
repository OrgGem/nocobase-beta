/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Context, Next } from '@nocobase/actions';
import { toOpenAIError } from '../utils/openai-format';

/**
 * Authentication middleware for /api/ai-llm/v1/* routes.
 *
 * Validates Bearer token against NocoBase's apiKeys collection.
 * Sets ctx.state.currentUser for downstream handlers.
 */
export async function authenticateBearer(ctx: Context): Promise<boolean> {
  const authHeader = ctx.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    ctx.status = 401;
    ctx.body = toOpenAIError(
      401,
      'Missing or invalid Authorization header. Expected: Bearer <api-key>',
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
    // Use NocoBase's auth system directly to validate the token.
    // NocoBase API keys are JWT tokens signed with the app secret.
    // We decode them directly via authManager.jwt rather than going through
    // the full NocoBase auth middleware stack (which requires being inside
    // the resourcer pipeline, but we run before it).
    const auth = ctx.app['authManager'];
    if (!auth) {
      ctx.status = 500;
      ctx.body = toOpenAIError(500, 'Auth system not available', 'server_error');
      return false;
    }

    // Try to authenticate using the token as a NocoBase JWT/API token
    // NocoBase API keys are essentially JWT tokens signed with the app secret
    const jwt = ctx.app['authManager']?.jwt;
    if (!jwt) {
      ctx.status = 500;
      ctx.body = toOpenAIError(500, 'JWT system not available', 'server_error');
      return false;
    }

    let decoded: any;
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

    // Load user
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
    ctx.state.currentRoles = decoded.roleName ? [decoded.roleName] : ['member'];

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
