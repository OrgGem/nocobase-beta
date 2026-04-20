/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Context } from '@nocobase/actions';
import { RateLimiter } from '../utils/rate-limiter';
import { toOpenAIError } from '../utils/openai-format';

/**
 * Creates a rate-limiting check function for use in the AI API router.
 *
 * Must be called AFTER authenticateBearer() so ctx.state.currentUser is set.
 * Reads rateLimitPerMinute from aiApiConfig on each request (cheap single-row read,
 * allows config changes to take effect immediately without restart).
 * Falls back to 60 req/min if the config record is missing or the field is 0/null.
 *
 * Returns false (and writes the 429 response) when the rate limit is exceeded.
 * Returns true when the request is allowed.
 *
 * Sets OpenAI-compatible rate limit response headers on every request:
 *   X-RateLimit-Limit: <limit>
 *   X-RateLimit-Remaining: <remaining> (on 429: 0)
 *   Retry-After: <seconds>  (on 429 only)
 */
export function createRateLimitMiddleware(limiter: RateLimiter) {
  return async (ctx: Context): Promise<boolean> => {
    const userId = ctx.state.currentUser?.id;
    // Auth runs before this; if somehow missing, fail open (don't block the request).
    if (userId === undefined || userId === null) return true;

    let limit = 60;
    try {
      const config = await ctx.db.getRepository('aiApiConfig').findOne();
      const configLimit = config?.rateLimitPerMinute;
      if (configLimit && configLimit > 0) {
        limit = configLimit;
      }
    } catch (configErr) {
      // Config read failure: fail open — don't block legitimate requests
      // Log at WARN so admins can detect DB connectivity issues
      ctx.app?.logger?.warn('[ai-api] Rate limit config read failed, using default (60/min)', configErr);
    }

    const result = limiter.check(userId, limit);

    if (!result.allowed) {
      const retryAfterSec = Math.ceil((result as any).retryAfterMs / 1000);
      ctx.set('Retry-After', String(retryAfterSec));
      ctx.set('X-RateLimit-Limit', String(limit));
      ctx.set('X-RateLimit-Remaining', '0');
      ctx.status = 429;
      ctx.body = toOpenAIError(
        429,
        `Rate limit exceeded. You have used all ${limit} requests allowed per minute. ` +
          `Please wait ${retryAfterSec} second${retryAfterSec !== 1 ? 's' : ''} before retrying.`,
        'requests',
        'rate_limit_exceeded',
      );
      return false;
    }

    ctx.set('X-RateLimit-Limit', String(limit));
    return true;
  };
}
