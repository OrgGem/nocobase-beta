import { describe, expect, it, vi } from 'vitest';
import { createAppObservabilityContract } from '../../contracts/app-observability';
import { MetricsStore } from '../../metrics/metrics-store';
import { registerMetricsResource } from '../metrics';

type Action = (
  ctx: Record<string, unknown> & { get(name: string): string },
  next: () => Promise<unknown>,
) => Promise<void>;

function setup(options: { enabled?: boolean; token?: string } = {}) {
  let action: Action;
  const app = {
    resourceManager: {
      define: ({ actions }: { actions: Record<string, Action> }) => {
        action = actions.metrics;
      },
    },
    acl: { allow: vi.fn() },
  };
  const store = new MetricsStore({ appName: 'main', nodeId: 'node-1' });
  registerMetricsResource(app, createAppObservabilityContract(store), {
    enabled: () => options.enabled ?? true,
    token: () => options.token,
  });
  return {
    store,
    async call(authorization = '') {
      const context: Record<string, unknown> & { get(name: string): string } = {
        get: () => authorization,
      };
      await action(context, async () => undefined);
      return context;
    },
  };
}

describe('metrics resource', () => {
  it('opts out of dataWrapping so the exposition body stays parseable text', async () => {
    const { store, call } = setup({ token: 'secret' });
    store.start({ service: 'http', operation: 'users:list' }).finish({ status: 'succeeded' });

    const ctx = await call('Bearer secret');

    expect(ctx.withoutDataWrapping).toBe(true);
    expect(ctx.type).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(String(ctx.body)).toContain('nocobase_app_observability_requests_total');
  });

  it('opts out of dataWrapping on the disabled and unauthorized paths too', async () => {
    const disabled = await setup({ enabled: false, token: 'secret' }).call('Bearer secret');
    expect(disabled.status).toBe(503);
    expect(disabled.withoutDataWrapping).toBe(true);

    const unauthorized = await setup({ token: 'secret' }).call('Bearer wrong');
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.withoutDataWrapping).toBe(true);
  });

  it('rejects a token of a different length without throwing', async () => {
    const ctx = await setup({ token: 'secret' }).call('Bearer s');
    expect(ctx.status).toBe(401);
  });
});
