import { timingSafeEqual } from 'crypto';
import type { AppObservabilityContract } from '../contracts';
import { exportPrometheus } from '../exporters/prometheus-exporter';

interface MetricsContext {
  body: unknown;
  type?: string;
  status?: number;
  get(name: string): string;
}
interface ResourceManagerLike {
  define(options: {
    name: string;
    actions: Record<string, (ctx: MetricsContext, next: () => Promise<unknown>) => Promise<void>>;
  }): void;
}
interface AclLike {
  allow(resource: string, action: string, strategy: string): void;
}
export function registerMetricsResource(
  app: { resourceManager: ResourceManagerLike; acl: AclLike },
  contract: AppObservabilityContract,
  options: { enabled: () => boolean; token: () => string | undefined },
): void {
  app.resourceManager.define({
    name: 'appObservabilityMetrics',
    actions: {
      metrics: async (ctx, next) => {
        const expected = options.token();
        const supplied = bearer(ctx.get('authorization'));
        if (!options.enabled() || !expected) {
          ctx.status = 503;
          ctx.body = 'Metrics export is disabled.';
          return;
        }
        if (!supplied || !secureEqual(expected, supplied)) {
          ctx.status = 401;
          ctx.body = 'Unauthorized';
          return;
        }
        ctx.type = 'text/plain; version=0.0.4; charset=utf-8';
        ctx.body = exportPrometheus(contract.getNodeSnapshot());
        await next();
      },
    },
  });
  app.acl.allow('appObservabilityMetrics', 'metrics', 'public');
}
function bearer(value: string): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1];
}
function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
