import http from 'http';
import type { AddressInfo } from 'net';
import { generateKeyPairSync } from 'crypto';
import { createMockServer, type MockServer } from '@nocobase/test';
import { generateApiKey } from '../services/key-manager';
import { generatePgpKey, type PgpKeyPair } from '../../../../plugin-crypto-toolkit/src/server/services/pgp-service';

export interface UpstreamRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/**
 * Minimal HTTP server standing in for the partner/internal backend.
 * Endpoints:
 *   /echo        — replies with the request body and the same content-type
 *   /status/:n   — replies with HTTP status n
 *   /delay/:ms   — waits ms before replying 200 "delayed"
 *   /flaky       — replies 500 while flakyRemaining > 0, then 200 "recovered"
 */
export class MockUpstream {
  baseUrl = '';
  requests: UpstreamRequest[] = [];
  flakyRemaining = 0;
  private server?: http.Server;

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const body = Buffer.concat(chunks);
          const path = req.url ?? '/';
          this.requests.push({ method: req.method ?? 'GET', path, headers: req.headers, body });

          const statusMatch = /^\/status\/(\d{3})/.exec(path);
          if (statusMatch) {
            const status = Number(statusMatch[1]);
            res.writeHead(status, { 'content-type': 'text/plain' });
            res.end(`status ${status}`);
            return;
          }

          // /headers/<name>/<value> — replies 200 with a custom response header.
          const headersMatch = /^\/headers\/([^/]+)\/([^/]+)/.exec(path);
          if (headersMatch) {
            res.writeHead(200, {
              'content-type': 'text/plain',
              [decodeURIComponent(headersMatch[1])]: decodeURIComponent(headersMatch[2]),
            });
            res.end('header-echo');
            return;
          }

          const delayMatch = /^\/delay\/(\d+)/.exec(path);
          if (delayMatch) {
            setTimeout(() => {
              res.writeHead(200, { 'content-type': 'text/plain' });
              res.end('delayed');
            }, Number(delayMatch[1]));
            return;
          }

          if (path.startsWith('/flaky')) {
            if (this.flakyRemaining > 0) {
              this.flakyRemaining -= 1;
              res.writeHead(500, { 'content-type': 'text/plain' });
              res.end('flaky failure');
            } else {
              res.writeHead(200, { 'content-type': 'text/plain' });
              res.end('recovered');
            }
            return;
          }

          if (path.startsWith('/echo')) {
            res.writeHead(200, { 'content-type': req.headers['content-type'] ?? 'application/octet-stream' });
            res.end(body);
            return;
          }

          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('not found');
        });
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address() as AddressInfo;
        this.server = server;
        this.baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }

  get lastRequest(): UpstreamRequest | undefined {
    return this.requests[this.requests.length - 1];
  }
}

export async function createTestApp(): Promise<MockServer> {
  process.env.INIT_ROOT_EMAIL = 'apim-test@nocobase.com';
  process.env.INIT_ROOT_PASSWORD = '123456';
  process.env.INIT_ROOT_NICKNAME = 'APIM Test';
  const app = await createMockServer({
    // acl defaults to false in mockServer(); enable it so permission checks
    // (e.g. apiRoutes:test requiring the plugin snippet) are enforced.
    acl: true,
    plugins: ['nocobase', 'plugin-crypto-toolkit', 'plugin-api-manager'],
  });
  // App Bearer token tests sign tokens with roleName 'admin'; bind that role to
  // the shared test partner so the gateway's partner match passes.
  await bindRoleToTestPartner(app, 'admin');
  return app;
}

const TEST_PARTNER_NAME = '__apim-test__';

/**
 * Every route and API key must belong to a partner (gateway tenant isolation).
 * Integration tests share one auto-created partner so individual tests do not
 * have to set partnerId explicitly.
 */
export async function ensureTestPartner(app: MockServer): Promise<number> {
  const repo = app.db.getRepository('apiPartners');
  const existing = await repo.findOne({ filter: { name: TEST_PARTNER_NAME } });
  if (existing) {
    return Number(existing.get('id'));
  }
  const created = await repo.create({ values: { name: TEST_PARTNER_NAME, enabled: true } });
  return Number(created.get('id'));
}

/**
 * Bind a NocoBase role to the shared test partner so app Bearer tokens carrying
 * that role pass the gateway's partner match (apiPartnerRoles).
 */
export async function bindRoleToTestPartner(app: MockServer, roleName: string): Promise<void> {
  const partnerId = await ensureTestPartner(app);
  const repo = app.db.getRepository('apiPartnerRoles');
  const existing = await repo.findOne({ filter: { partnerId, roleName } });
  if (!existing) {
    await repo.create({ values: { partnerId, roleName } });
  }
}

export async function loginAgent(app: MockServer) {
  const user = await app.db.getRepository('users').findOne({ filter: { email: process.env.INIT_ROOT_EMAIL } });
  return app.agent().login(user);
}

export interface TestApiKeyOptions {
  name?: string;
  scopes?: string[];
  partnerId?: number | null;
  expiresAt?: Date | null;
  revokedAt?: Date | null;
  enabled?: boolean;
}

export async function createTestApiKey(app: MockServer, options: TestApiKeyOptions = {}): Promise<string> {
  const generated = generateApiKey();
  const partnerId = options.partnerId ?? (await ensureTestPartner(app));
  await app.db.getRepository('apiManagerApiKeys').create({
    values: {
      name: options.name ?? `test-key-${Math.random().toString(36).slice(2, 10)}`,
      partnerId,
      keyHash: generated.keyHash,
      keyPrefix: generated.keyPrefix,
      scopes: options.scopes ?? ['inbound', 'outbound'],
      expiresAt: options.expiresAt ?? null,
      revokedAt: options.revokedAt ?? null,
      enabled: options.enabled ?? true,
    },
  });
  return generated.plaintext;
}

export async function createTestRoute(app: MockServer, values: Record<string, unknown>) {
  const partnerId = values.partnerId ?? (await ensureTestPartner(app));
  return app.db.getRepository('apiRoutes').create({
    values: {
      direction: 'outbound',
      method: 'POST',
      targetUrl: 'http://127.0.0.1:9/unused',
      enabled: true,
      authMode: 'both',
      encryptionMode: 'none',
      wireFormat: 'binary',
      timeoutMs: 5000,
      retryCount: 0,
      retryDelayMs: 10,
      maxBodyMb: 1,
      logPayloads: false,
      ...values,
      partnerId,
    },
  });
}

export interface PgpFixture {
  pair: PgpKeyPair;
  keyName: string;
  envVar: string;
}

/**
 * Creates a cryptoKeys row plus the env var holding the private material,
 * matching the convention used by plugin-crypto-toolkit (privateEnvVar, with
 * an optional <privateEnvVar>_PASSPHRASE companion variable).
 */
export async function createPgpKeyFixture(
  app: MockServer,
  opts: { name: string; direction: 'own' | 'partner'; envVar?: string; passphrase?: string },
): Promise<PgpFixture> {
  const pair = await generatePgpKey({
    userIds: [{ name: `APIM ${opts.name}`, email: `${opts.name.replace(/[^a-z0-9]/gi, '')}@apim.test` }],
    type: 'ecc',
    curve: 'curve25519',
    passphrase: opts.passphrase,
  });
  const envVar = opts.envVar ?? `CRYPTO_TOOLKIT_APIM_${opts.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_PRIVATE`;
  process.env[envVar] = pair.privateKey;
  if (opts.passphrase) {
    process.env[`${envVar}_PASSPHRASE`] = opts.passphrase;
  }
  await app.db.getRepository('cryptoKeys').create({
    values: {
      name: opts.name,
      kind: 'pgp-curve25519',
      direction: opts.direction,
      purpose: 'both',
      publicMaterial: pair.publicKey,
      publicFormat: 'openpgp',
      privateEnvVar: opts.direction === 'own' ? envVar : null,
      enabled: true,
    },
  });
  return { pair, keyName: opts.name, envVar };
}

export interface RsaFixture {
  publicPem: string;
  privatePem: string;
  keyName: string;
  envVar: string;
}

/**
 * RSA analogue of createPgpKeyFixture. Uses a 2048-bit pair for speed; the
 * gateway only checks the key type, not the size.
 */
export async function createRsaKeyFixture(
  app: MockServer,
  opts: { name: string; direction: 'own' | 'partner'; envVar?: string },
): Promise<RsaFixture> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const envVar = opts.envVar ?? `CRYPTO_TOOLKIT_APIM_${opts.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_PRIVATE`;
  process.env[envVar] = privatePem;
  await app.db.getRepository('cryptoKeys').create({
    values: {
      name: opts.name,
      kind: 'rsa-4096',
      direction: opts.direction,
      purpose: 'encrypt',
      publicMaterial: publicPem,
      publicFormat: 'pem',
      privateEnvVar: opts.direction === 'own' ? envVar : null,
      enabled: true,
    },
  });
  return { publicPem, privatePem, keyName: opts.name, envVar };
}

/** supertest binary response parser: makes res.body a Buffer. */
export function binaryParser(res: http.IncomingMessage, callback: (err: Error | null, body: Buffer) => void) {
  res.setEncoding('binary');
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  res.on('end', () => {
    callback(null, Buffer.from(data, 'binary'));
  });
}
