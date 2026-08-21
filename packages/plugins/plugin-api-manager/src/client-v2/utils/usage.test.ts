import { describe, expect, it } from 'vitest';
import { buildCurlExample, getRouteEndpoint, getRequiredScopes } from './usage';

const BASE = 'https://gw.example.com';

describe('usage buildCurlExample', () => {
  it('builds a POST example with body for outbound routes', () => {
    const route = {
      name: 'orders',
      direction: 'outbound' as const,
      method: 'POST',
      targetUrl: 'https://partner.example.com/api/orders',
      encryptionMode: 'none' as const,
      wireFormat: 'binary' as const,
    };
    const curl = buildCurlExample(route, BASE);
    expect(curl).toContain(`curl -X POST '${BASE}/api/apim/outbound/orders'`);
    expect(curl).toContain("'X-API-Key: <YOUR_API_KEY>'");
    expect(curl).toContain('-d \'{"example": "value"}\'');
  });

  it('builds a GET example without a body', () => {
    const route = {
      name: 'status',
      direction: 'outbound' as const,
      method: 'GET',
      targetUrl: 'https://partner.example.com/status',
      encryptionMode: 'none' as const,
      wireFormat: 'binary' as const,
    };
    const curl = buildCurlExample(route, BASE);
    expect(curl).toContain(`curl -X GET '${BASE}/api/apim/outbound/status'`);
    expect(curl).not.toContain("-d '");
  });

  it('builds an inbound example with the JSON envelope for encrypted json wire', () => {
    const route = {
      name: 'orders-import',
      direction: 'inbound' as const,
      inboundPath: 'partner/orders',
      method: 'POST',
      targetUrl: 'https://internal.example.com/orders',
      encryptionMode: 'aes-256-gcm' as const,
      wireFormat: 'json' as const,
    };
    const curl = buildCurlExample(route, BASE);
    expect(curl).toContain(`${BASE}/api/apim/inbound/partner/orders`);
    expect(curl).toContain('NCB1');
    expect(curl).toContain('ciphertext');
  });

  it('getRequiredScopes returns bare and route-scoped scopes', () => {
    const route = {
      name: 'orders',
      direction: 'inbound' as const,
      method: 'POST',
      targetUrl: 'x',
      encryptionMode: 'none' as const,
      wireFormat: 'binary' as const,
    };
    expect(getRequiredScopes(route)).toEqual(['inbound', 'inbound:orders']);
  });

  it('getRouteEndpoint uses inboundPath for inbound routes', () => {
    const route = {
      name: 'orders-import',
      direction: 'inbound' as const,
      inboundPath: 'partner/orders',
      method: 'POST',
      targetUrl: 'x',
      encryptionMode: 'none' as const,
      wireFormat: 'binary' as const,
    };
    expect(getRouteEndpoint(route, BASE)).toBe(`${BASE}/api/apim/inbound/partner/orders`);
  });
});
