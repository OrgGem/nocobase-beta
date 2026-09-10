import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegistryConnection } from '../../../shared/types';
import { EcrAuthProvider, clearEcrAuthCacheForTests, type EcrClientLike } from '../ecr-auth';
import { EcrCatalogProvider, type EcrCatalogClientLike } from '../ecr-catalog';
import { RegistryClient } from '../registry-client';

function ecrSettings(url: string, credentialMode: RegistryConnection['credentialMode'] = 'ecr'): RegistryConnection {
  return {
    displayName: 'ECR Registry',
    registryUrl: url,
    publicRegistryHost: '',
    credentialMode,
    username: '',
    awsRegion: 'ap-southeast-1',
    awsRoleArn: '',
    verifyTls: true,
    allowInsecureHttp: true,
    caCertificate: '',
    clientCertificate: '',
    requestTimeoutMs: 5000,
    catalogPageSize: 100,
    maxConcurrentRequests: 5,
    autoRefreshSeconds: 0,
    deleteEnabled: true,
    rawManifestEnabled: true,
    showLegacySchema1: false,
    maxTransferSizeMb: 4096,
    uploadChunkSizeMb: 4,
    transferTimeoutMs: 600000,
    maxDownloadSpeedKbps: 0,
    maxUploadSpeedKbps: 0,
    hasPassword: false,
    hasBearerToken: false,
    hasClientPrivateKey: false,
    hasClientPrivateKeyPassphrase: false,
    hasAwsAccessKeyId: false,
    hasAwsSecretAccessKey: false,
  };
}

function mockEcrSend(handler: (sendIndex: number) => unknown): ReturnType<typeof vi.fn> {
  const send = vi.fn();
  send.mockImplementation(async () => handler(send.mock.calls.length - 1));
  return send;
}

function ecrAuthFactory(send: ReturnType<typeof vi.fn>): () => EcrClientLike {
  return () => ({ send }) as EcrClientLike;
}

function ecrCatalogClient(handler: (command: unknown) => unknown) {
  const send = vi.fn();
  send.mockImplementation(async (command: unknown) => handler(command));
  return { send } as unknown as EcrCatalogClientLike;
}

describe('RegistryClient with ECR credential mode', () => {
  let server: Server;
  let registryUrl: string;
  let unauthorizedOnce: boolean;
  const seenRequests: Array<{ method: string; url: string; authorization?: string }> = [];

  beforeEach(async () => {
    clearEcrAuthCacheForTests();
    unauthorizedOnce = false;
    seenRequests.length = 0;
    server = createServer((request, response) => {
      seenRequests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization,
      });
      if (request.method === 'GET' && request.url === '/v2/') {
        if (unauthorizedOnce) {
          unauthorizedOnce = false;
          response.writeHead(401, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ errors: [{ code: 'UNAUTHORIZED', message: 'authentication required' }] }));
          return;
        }
        response.writeHead(200, { 'Docker-Distribution-API-Version': 'registry/2.0' });
        response.end();
        return;
      }
      if (request.method === 'GET' && request.url === '/v2/team/api/tags/list?n=100') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ name: 'team/api', tags: ['latest', 'stable'] }));
        return;
      }
      if (request.method === 'GET' && request.url?.startsWith('/v2/_catalog')) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ repositories: ['from-catalog-endpoint'] }));
        return;
      }
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ errors: [{ code: 'NOT_FOUND', message: 'not found' }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');
    registryUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it('sends the ECR Basic authorization header on data-plane requests', async () => {
    const token = Buffer.from('AWS:ecr-password').toString('base64');
    const send = mockEcrSend(() => ({
      authorizationData: [{ authorizationToken: token, expiresAt: new Date(Date.now() + 12 * 60 * 60_000) }],
    }));
    const ecrAuth = new EcrAuthProvider({
      region: 'ap-southeast-1',
      registryHost: '127.0.0.1',
      createClient: ecrAuthFactory(send),
    });
    const client = new RegistryClient(ecrSettings(registryUrl), { ecrAuth });
    await expect(client.health()).resolves.toMatchObject({ reachable: true, authentication: 'public' });
    expect(seenRequests[0].authorization).toBe(`Basic ${token}`);
  });

  it('force-refreshes the ECR token and retries once after a 401', async () => {
    const firstToken = Buffer.from('AWS:first').toString('base64');
    const secondToken = Buffer.from('AWS:second').toString('base64');
    const send = mockEcrSend((index) => ({
      authorizationData: [
        {
          authorizationToken: index === 0 ? firstToken : secondToken,
          expiresAt: new Date(Date.now() + 12 * 60 * 60_000),
        },
      ],
    }));
    const ecrAuth = new EcrAuthProvider({
      region: 'ap-southeast-1',
      registryHost: '127.0.0.1',
      createClient: ecrAuthFactory(send),
    });
    const client = new RegistryClient(ecrSettings(registryUrl), { ecrAuth });
    unauthorizedOnce = true;
    await expect(client.health()).resolves.toMatchObject({ reachable: true, authentication: 'public' });
    expect(send).toHaveBeenCalledTimes(2);
    const v2Requests = seenRequests.filter((entry) => entry.url === '/v2/');
    expect(v2Requests).toHaveLength(2);
    expect(v2Requests[0].authorization).toBe(`Basic ${firstToken}`);
    expect(v2Requests[1].authorization).toBe(`Basic ${secondToken}`);
  });

  it('delegates listRepositories to the ECR Control Plane and never calls /v2/_catalog', async () => {
    const send = mockEcrSend(() => ({
      authorizationData: [{ authorizationToken: 'token', expiresAt: new Date(Date.now() + 12 * 60 * 60_000) }],
    }));
    const ecrAuth = new EcrAuthProvider({
      region: 'ap-southeast-1',
      registryHost: '127.0.0.1',
      createClient: ecrAuthFactory(send),
    });
    const catalogClient = ecrCatalogClient(() => ({
      repositories: [{ repositoryName: 'team/api' }, { repositoryName: 'team/worker' }],
    }));
    const ecrCatalog = new EcrCatalogProvider({
      region: 'ap-southeast-1',
      createClient: () => catalogClient,
    });
    const client = new RegistryClient(ecrSettings(registryUrl), { ecrAuth, ecrCatalog });
    await expect(client.listRepositories()).resolves.toEqual({ items: ['team/api', 'team/worker'] });
    expect(seenRequests.some((entry) => entry.url.startsWith('/v2/_catalog'))).toBe(false);
  });

  it('keeps listing tags through the V2 tags/list endpoint in ECR mode', async () => {
    const send = mockEcrSend(() => ({
      authorizationData: [{ authorizationToken: 'token', expiresAt: new Date(Date.now() + 12 * 60 * 60_000) }],
    }));
    const ecrAuth = new EcrAuthProvider({
      region: 'ap-southeast-1',
      registryHost: '127.0.0.1',
      createClient: ecrAuthFactory(send),
    });
    const client = new RegistryClient(ecrSettings(registryUrl), { ecrAuth });
    await expect(client.listTags('team/api')).resolves.toEqual({ items: ['latest', 'stable'] });
    expect(seenRequests.some((entry) => entry.url.startsWith('/v2/team/api/tags/list'))).toBe(true);
  });

  it('still uses /v2/_catalog when the credential mode is not ecr', async () => {
    const client = new RegistryClient(ecrSettings(registryUrl, 'anonymous'));
    await expect(client.listRepositories()).resolves.toEqual({ items: ['from-catalog-endpoint'] });
    expect(seenRequests.some((entry) => entry.url.startsWith('/v2/_catalog'))).toBe(true);
  });
});
