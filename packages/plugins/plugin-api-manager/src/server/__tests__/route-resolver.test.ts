import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockServer } from '@nocobase/test';
import { findRoute } from '../services/route-resolver';
import { createTestApp, createTestRoute } from './helpers';

describe('route-resolver findRoute', () => {
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
    const route = await findRoute(app.db, 'inbound', 'orders', 'POST');
    expect(route).toBeTruthy();
    expect(route?.get('name')).toBe('in-orders');
  });

  it('is case-insensitive on method', async () => {
    const route = await findRoute(app.db, 'inbound', 'orders', 'post');
    expect(route).toBeTruthy();
  });

  it('returns null on method mismatch', async () => {
    const route = await findRoute(app.db, 'inbound', 'orders', 'GET');
    expect(route).toBeNull();
  });

  it('returns null for unknown paths', async () => {
    const route = await findRoute(app.db, 'inbound', 'nope', 'POST');
    expect(route).toBeNull();
  });

  it('returns null for disabled routes', async () => {
    const route = await findRoute(app.db, 'inbound', 'disabled-path', 'POST');
    expect(route).toBeNull();
  });

  it('matches an outbound route by name', async () => {
    const route = await findRoute(app.db, 'outbound', 'out-partner', 'PUT');
    expect(route).toBeTruthy();
    expect(route?.get('inboundPath')).toBeFalsy();
  });

  it('does not match outbound names for inbound lookups', async () => {
    const route = await findRoute(app.db, 'inbound', 'out-partner', 'PUT');
    expect(route).toBeNull();
  });
});
