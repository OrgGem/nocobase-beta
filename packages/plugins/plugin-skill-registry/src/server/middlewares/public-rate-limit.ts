import type { Context } from '@nocobase/actions';

import { RegistryError, toRegistryError } from '../contracts/errors';
import {
  PublicRateLimitExceededError,
  PublicRateLimiter,
  type PublicRateLimitBucket,
} from '../services/public-rate-limiter';
import { distributedTopologyReady } from '../services/registry-readiness-service';
import { attachTrustedClientIp } from '../services/trusted-client-ip';

type ActionContext = Context & {
  set(name: string, value: string): void;
  state: Record<string, unknown>;
};

function bucketFor(action: string): PublicRateLimitBucket | null {
  if (action === 'list') {
    return 'catalog';
  }
  if (action === 'download') {
    return 'download';
  }
  if (['get', 'versions', 'metadata'].includes(action)) {
    return 'detail';
  }
  return null;
}

export function createPublicRateLimitMiddleware(getLimiter: () => PublicRateLimiter | undefined) {
  return async (ctx: Context, next: () => Promise<void>) => {
    if (ctx.action.resourceName !== 'skillRegistryPublic') {
      await next();
      return;
    }
    const bucket = bucketFor(ctx.action.actionName);
    if (!bucket) {
      await next();
      return;
    }
    if (process.env.SKILL_REGISTRY_PUBLIC_ENABLED?.toLowerCase() !== 'true') {
      throw new RegistryError('PUBLIC_REGISTRY_DISABLED', 503, 'Public registry endpoints are disabled.');
    }
    const limiter = getLimiter();
    if (!limiter) {
      throw new RegistryError('RATE_LIMITER_UNAVAILABLE', 503, 'Public rate limiter is not ready.');
    }
    if (!distributedTopologyReady(limiter.scope)) {
      throw new RegistryError(
        'REGISTRY_TOPOLOGY_UNREADY',
        503,
        'Public registry traffic requires shared rate limiting, artifact storage, and operation locks in cluster mode.',
      );
    }
    try {
      const actionContext = ctx as ActionContext;
      const ip = attachTrustedClientIp(actionContext);
      const result = await limiter.enforce(bucket, ip);
      actionContext.set('RateLimit-Limit', String(result.limit));
      actionContext.set('RateLimit-Remaining', String(result.remaining));
      actionContext.set('RateLimit-Reset', String(result.resetSeconds));
      await next();
    } catch (error) {
      const registryError = toRegistryError(error);
      if (error instanceof PublicRateLimitExceededError) {
        const actionContext = ctx as ActionContext;
        actionContext.set('Retry-After', String(error.rateLimit.resetSeconds));
        actionContext.set('RateLimit-Limit', String(error.rateLimit.limit));
        actionContext.set('RateLimit-Remaining', '0');
        actionContext.set('RateLimit-Reset', String(error.rateLimit.resetSeconds));
      }
      throw registryError;
    }
  };
}
