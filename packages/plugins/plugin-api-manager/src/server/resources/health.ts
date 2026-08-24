import type { Context } from '@nocobase/actions';
import type { Application } from '@nocobase/server';
import type { Handlers } from '@nocobase/resourcer';
import type { ApimRuntimeState } from '../gateway/router';

/**
 * Diagnostics endpoint for the gateway runtime state. Returns live in-memory
 * metrics for the capacity limiter and circuit breaker plus the current
 * resolved settings (env > DB singleton > default).
 *
 * Exposed as POST `apiManager:health` (admin ACL only) so it can be polled by
 * dashboards from the same gateway that owns the in-memory instances.
 */
export function registerHealthResource(app: Application, state?: ApimRuntimeState): void {
  const handlers: Handlers = {
    async health(ctx: Context, next) {
      if (!state) {
        ctx.body = {
          ok: true,
          state: 'degraded',
          reason: 'gateway runtime state not wired for diagnostics',
          capacity: null,
          circuits: {},
        };
        await next();
        return;
      }

      ctx.body = {
        ok: true,
        state: 'ok',
        capacity: state.capacityLimiter.getStats(),
        circuits: state.circuitBreaker.getStats(),
      };
      await next();
    },
  };

  app.resourceManager.define({
    name: 'apiManager',
    actions: handlers,
  });
}
