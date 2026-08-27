import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockServer } from '@nocobase/test';
import {
  APIM_ROUTES_ALL_SNIPPET,
  APIM_ROUTES_RESOURCE,
  canRoleCallRoute,
  registerAllRoutesSnippet,
  registerRouteSnippets,
  routeCallAction,
  routeSnippetName,
  syncApimRoutesAvailableActions,
  grantRouteActionToRole,
  revokeRouteActionFromRole,
} from '../services/acl';
import { createTestApp, createTestRoute, loginAgent } from './helpers';

describe('acl integration (apiManagerApiKeys -> role)', () => {
  let app: MockServer;
  let agent: Awaited<ReturnType<typeof loginAgent>>;

  beforeAll(async () => {
    app = await createTestApp();
    agent = await loginAgent(app);
  }, 300000);

  afterAll(async () => {
    await app?.destroy();
  });

  it('root role can call any route', async () => {
    expect(canRoleCallRoute(app, 'root', 'any-route')).toBe(true);
  });

  it('denies a role that has no grant', async () => {
    const acl = app.acl;
    acl.define({ role: 'apim-denied' });
    expect(canRoleCallRoute(app, 'apim-denied', 'no-grant-route')).toBe(false);
  });

  it('allows a role with the per-route snippet', async () => {
    const acl = app.acl;
    registerRouteSnippets(acl, ['orders.sync']);
    const role = acl.define({ role: 'apim-route-snippet' });
    role.snippets.add(routeSnippetName('orders.sync'));
    expect(canRoleCallRoute(app, 'apim-route-snippet', 'orders.sync')).toBe(true);
    // A different route stays denied.
    expect(canRoleCallRoute(app, 'apim-route-snippet', 'invoices.sync')).toBe(false);
  });

  it('allows a role with the all-routes snippet', async () => {
    const acl = app.acl;
    registerAllRoutesSnippet(acl);
    const role = acl.define({ role: 'apim-all-snippet' });
    role.snippets.add(APIM_ROUTES_ALL_SNIPPET);
    expect(canRoleCallRoute(app, 'apim-all-snippet', 'anything.goes')).toBe(true);
  });

  it('grantRouteActionToRole adds the per-route snippet and grants access', async () => {
    const acl = app.acl;
    registerRouteSnippets(acl, ['granted.route']);
    const role = acl.define({ role: 'apim-grant-snippet' });
    grantRouteActionToRole(acl, 'apim-grant-snippet', 'granted.route');
    expect(canRoleCallRoute(app, 'apim-grant-snippet', 'granted.route')).toBe(true);
    expect(canRoleCallRoute(app, 'apim-grant-snippet', 'other.route')).toBe(false);
  });

  it('revokeRouteActionFromRole removes the per-route snippet', async () => {
    const acl = app.acl;
    registerRouteSnippets(acl, ['temp.route']);
    const role = acl.define({ role: 'apim-revoke-snippet' });
    grantRouteActionToRole(acl, 'apim-revoke-snippet', 'temp.route');
    expect(canRoleCallRoute(app, 'apim-revoke-snippet', 'temp.route')).toBe(true);
    revokeRouteActionFromRole(acl, 'apim-revoke-snippet', 'temp.route');
    expect(canRoleCallRoute(app, 'apim-revoke-snippet', 'temp.route')).toBe(false);
  });

  it('does not fall back to the plugin snippet (fail-closed for non-root roles)', async () => {
    const acl = app.acl;
    const role = acl.define({ role: 'apim-plugin-only' });
    role.snippets.add('pm.plugin-api-manager');
    // Having the admin plugin snippet alone must NOT grant route calls:
    // route permissions are granted explicitly via apimRoutes grants/snippets.
    expect(canRoleCallRoute(app, 'apim-plugin-only', 'some.route')).toBe(false);
  });

  it('syncs availableActions for existing routes and drops stale ones', async () => {
    const acl = app.acl;
    const route = await createTestRoute(app, { name: 'acl-avail-route', direction: 'outbound' });
    syncApimRoutesAvailableActions(acl, ['acl-avail-route']);
    const available = acl.getAvailableActions();
    expect(available.has(routeCallAction('acl-avail-route'))).toBe(true);
    expect(available.get(routeCallAction('acl-avail-route'))?.options.resource).toBe(APIM_ROUTES_RESOURCE);

    // Stale entry removed after re-sync without the route.
    syncApimRoutesAvailableActions(acl, []);
    expect(available.has(routeCallAction('acl-avail-route'))).toBe(false);
  });

  it('registerRouteSnippets registers valid snippet names (no wildcard throw)', async () => {
    const acl = app.acl;
    expect(() => registerRouteSnippets(acl, ['a.b-c_d'])).not.toThrow();
    const snippets = (acl as unknown as { snippetManager?: { snippets?: Map<string, unknown> } }).snippetManager
      ?.snippets;
    expect(snippets?.has(routeSnippetName('a.b-c_d'))).toBe(true);
  });

  it('apiRoutes:test action stays gated behind the plugin snippet', async () => {
    const withSnippet = app.acl.define({ role: 'apim-test-snippet' });
    withSnippet.snippets.add('pm.plugin-api-manager');
    expect(app.acl.can({ role: 'apim-test-snippet', resource: 'apiRoutes', action: 'test' })).toBeTruthy();
    const without = app.acl.define({ role: 'apim-test-no-snippet' });
    expect(app.acl.can({ role: 'apim-test-no-snippet', resource: 'apiRoutes', action: 'test' })).toBeNull();
  });

  it('admin role (seeded with pm.* snippets) may call routes registered as snippets', async () => {
    registerRouteSnippets(app.acl, ['admin-route']);
    // The seeded admin role carries the pm.* snippets; the per-route snippet is
    // matched through pm.*, so admin can call the route.
    expect(canRoleCallRoute(app, 'admin', 'admin-route')).toBe(true);
  });

  it('dynamic grants take effect immediately and revocations deny immediately', async () => {
    const acl = app.acl;
    registerRouteSnippets(acl, ['live.route']);
    const role = acl.define({ role: 'apim-live-role' });
    expect(canRoleCallRoute(app, 'apim-live-role', 'live.route')).toBe(false);
    grantRouteActionToRole(acl, 'apim-live-role', 'live.route');
    expect(canRoleCallRoute(app, 'apim-live-role', 'live.route')).toBe(true);
    revokeRouteActionFromRole(acl, 'apim-live-role', 'live.route');
    expect(canRoleCallRoute(app, 'apim-live-role', 'live.route')).toBe(false);
  });
});
