import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockServer } from '@nocobase/test';
import { resolveGatewayRoute } from '../services/route-resolver';
import { ApimError } from '../services/errors';
import { createTestApp, createTestRoute } from './helpers';

describe('route-resolver resolveGatewayRoute', () => {
  let app: MockServer;

  beforeAll(async () => {
    app = await createTestApp();
    await createTestRoute(app, { name: 'in-orders', direction: 'inbound', inboundPath: 'orders', method: 'POST' });
    await createTestRoute(app, {
      name: 'in-disabled',
      direction: 'inbound',
      inboundPath: 'disabled-path',
      method: 'POST',
      enabled: false,
    });
    await createTestRoute(app, { name: 'out-partner', direction: 'outbound', method: 'PUT' });
  }, 300000);

  afterAll(async () => {
    await app?.destroy();
  });

  it('matches an inbound route by path and method', async () => {
    const route = await resolveGatewayRoute(app.db, 'inbound', 'orders', 'POST');
    expect(route.get('name')).toBe('in-orders');
  });

  it('is case-insensitive on method', async () => {
    const route = await resolveGatewayRoute(app.db, 'inbound', 'orders', 'post');
    expect(route.get('name')).toBe('in-orders');
  });

  it('throws a 405 ApimError on method mismatch', async () => {
    await expect(resolveGatewayRoute(app.db, 'inbound', 'orders', 'GET')).rejects.toMatchObject({
      name: 'ApimError',
      httpStatus: 405,
    });
  });

  it('throws a 404 ApimError for unknown paths', async () => {
    await expect(resolveGatewayRoute(app.db, 'inbound', 'nope', 'POST')).rejects.toMatchObject({
      name: 'ApimError',
      httpStatus: 404,
    });
  });

  it('throws a 404 ApimError for disabled routes', async () => {
    await expect(resolveGatewayRoute(app.db, 'inbound', 'disabled-path', 'POST')).rejects.toMatchObject({
      name: 'ApimError',
      httpStatus: 404,
    });
  });

  it('matches an outbound route by name', async () => {
    const route = await resolveGatewayRoute(app.db, 'outbound', 'out-partner', 'PUT');
    expect(route.get('inboundPath')).toBeFalsy();
  });

  it('does not match outbound names for inbound lookups', async () => {
    await expect(resolveGatewayRoute(app.db, 'inbound', 'out-partner', 'PUT')).rejects.toBeInstanceOf(ApimError);
  });
});
