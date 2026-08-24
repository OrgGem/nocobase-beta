import { describe, expect, it } from 'vitest';
import type { Application } from '@nocobase/server';
import { buildOutboundForwardRequest } from '../services/outbound-pipeline';
import { HMAC_SIGNATURE_HEADER, verifyHmacHeaders } from '../services/hmac-signer';

function routeFrom(values: Record<string, unknown>) {
  return { get: (name: string) => values[name] };
}

function createFakeApp() {
  const keys = new Map<string, { name: string; publicMaterial: string; privateEnvVar?: string | null }>();
  const app = {
    aesEncryptor: {
      encrypt: async (value: string) => `enc:${value}`,
      decrypt: async (value: string) => String(value).replace(/^enc:/, ''),
    },
    db: {
      getRepository: (name: string) => {
        if (name !== 'cryptoKeys') throw new Error(`unexpected repository ${name}`);
        return {
          findOne: async ({ filter }: { filter: { name: string; enabled?: boolean } }) => {
            const row = keys.get(filter.name);
            if (!row || (filter.enabled === true && !row.enabled)) return null;
            return { get: (field: string) => (row as unknown as Record<string, unknown>)[field] };
          },
        };
      },
    },
  };
  const toolkit = {
    encryptPayload: async () => {
      throw new Error('not used');
    },
    decryptPayload: async () => {
      throw new Error('not used');
    },
    resolveOwnPrivateKeyMaterial: async (keyRecord: { get(name: string): unknown }) => {
      const envVar = String(keyRecord.get('privateEnvVar') ?? '');
      const material = process.env[envVar];
      if (!material) throw new Error(`private env ${envVar} is unset`);
      return { material, passphrase: process.env[`${envVar}_PASSPHRASE`] };
    },
    getEnvVal: (name: string) => process.env[name],
  };
  const appWithPm = {
    ...app,
    pm: { get: (name: string) => (name === 'crypto-toolkit' ? toolkit : undefined) },
  };
  return { app: appWithPm as unknown as Application, keys };
}

describe('outbound-pipeline buildOutboundForwardRequest', () => {
  const baseRoute = {
    direction: 'outbound',
    method: 'POST',
    encryptionMode: 'none',
    wireFormat: 'binary',
    hmacSignEnabled: false,
    jwtSignEnabled: false,
  };

  it('passes the body through unchanged when no encryption or signing is enabled', async () => {
    const { app } = createFakeApp();
    const body = Buffer.from('{"a":1}');
    const forward = await buildOutboundForwardRequest(app, routeFrom(baseRoute), {
      body,
      contentType: 'application/json',
      forwardUrl: 'https://partner.example.com/api/orders?x=1',
    });
    expect(forward.body.equals(body)).toBe(true);
    expect(forward.contentType).toBe('application/json');
    expect(forward.headers['content-type']).toBe('application/json');
    expect(forward.headers[HMAC_SIGNATURE_HEADER]).toBeUndefined();
  });

  it('applies static headers over incoming headers', async () => {
    const { app } = createFakeApp();
    const forward = await buildOutboundForwardRequest(app, routeFrom(baseRoute), {
      body: Buffer.from('x'),
      contentType: 'text/plain',
      forwardUrl: 'https://partner.example.com/x',
      incomingHeaders: { 'x-caller': 'me', host: 'api.example.com' },
      staticHeaders: [{ name: 'X-Api-Version', value: 'v2' }],
    });
    expect(forward.headers['x-caller']).toBe('me');
    expect(forward.headers['x-api-version']).toBe('v2');
    expect(forward.headers.host).toBeUndefined();
  });

  it('signs with HMAC using the encrypted secret', async () => {
    const { app } = createFakeApp();
    const secret = 'shared-secret';
    const route = routeFrom({
      ...baseRoute,
      hmacSignEnabled: true,
      hmacSecret: `enc:${secret}`,
    });
    const body = Buffer.from('payload');
    const forward = await buildOutboundForwardRequest(app, route, {
      body,
      contentType: 'text/plain',
      forwardUrl: 'https://partner.example.com/api/orders?a=1',
    });
    expect(forward.headers[HMAC_SIGNATURE_HEADER]).toBeTruthy();
    expect(() =>
      verifyHmacHeaders({
        secret,
        method: 'POST',
        path: '/api/orders?a=1',
        body,
        headers: forward.headers,
        toleranceSec: 300,
        nonceCache: { has: () => false, add: () => undefined } as never,
      }),
    ).not.toThrow();
  });

  it('injects a Bearer JWT when jwtSignEnabled with HS256', async () => {
    const { app } = createFakeApp();
    const route = routeFrom({
      ...baseRoute,
      jwtSignEnabled: true,
      jwtSignAlgorithm: 'HS256',
      jwtSecret: 'enc:jwt-secret',
      jwtIssuer: 'apim',
      jwtAudience: 'backend',
      jwtExpiresInSec: 120,
    });
    const forward = await buildOutboundForwardRequest(app, route, {
      body: Buffer.from('{}'),
      contentType: 'application/json',
      forwardUrl: 'https://partner.example.com/x',
    });
    expect(forward.headers.Authorization).toMatch(/^Bearer .+\..+\..+$/);
  });
});
