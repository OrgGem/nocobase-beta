import { createServer, type Server } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RegistryConnection } from '../../../shared/types';
import { RegistryClient } from '../registry-client';

function settings(url: string): RegistryConnection {
  return {
    displayName: 'Test Registry',
    registryUrl: url,
    publicRegistryHost: 'registry.test',
    credentialMode: 'anonymous',
    username: '',
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
  };
}

function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<Server> {
  const server = createServer(handler);
  return new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)).then(() => server);
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function addressUrl(server: Server): string {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');
  return `http://127.0.0.1:${address.port}`;
}

describe('RegistryClient bearer token cache', () => {
  let tokenServer: Server;
  let registryA: Server;
  let registryB: Server;
  let tokenServerUrl: string;
  let tokenRequests = 0;
  let issuedTokens = 0;

  beforeEach(async () => {
    tokenRequests = 0;
    issuedTokens = 0;

    tokenServer = await listen((request, response) => {
      if (request.url?.startsWith('/token')) {
        tokenRequests += 1;
        issuedTokens += 1;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ token: `token-${issuedTokens}`, expires_in: 60 }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    tokenServerUrl = addressUrl(tokenServer);

    const challenge = `Bearer realm="${tokenServerUrl}/token",service="registry-service",scope="repository:team/api:pull"`;

    const registry = (expectedToken: string) =>
      listen((request, response) => {
        if (request.url === '/v2/') {
          if (request.headers.authorization === `Bearer ${expectedToken}`) {
            response.writeHead(200, { 'Docker-Distribution-API-Version': `registry/2.0-${expectedToken}` });
            response.end();
            return;
          }
          response.writeHead(401, { 'WWW-Authenticate': challenge });
          response.end();
          return;
        }
        response.writeHead(404);
        response.end();
      });

    registryA = await registry('token-1');
    registryB = await registry('token-2');
  });

  afterEach(async () => {
    await close(registryA);
    await close(registryB);
    await close(tokenServer);
  });

  it('reuses a cached token within one registry and isolates tokens across registry origins', async () => {
    const clientA = new RegistryClient(settings(addressUrl(registryA)));
    const clientB = new RegistryClient(settings(addressUrl(registryB)));

    await expect(clientA.health()).resolves.toMatchObject({
      reachable: true,
      apiVersion: 'registry/2.0-token-1',
    });
    await expect(clientA.health()).resolves.toMatchObject({
      reachable: true,
      apiVersion: 'registry/2.0-token-1',
    });

    await expect(clientB.health()).resolves.toMatchObject({
      reachable: true,
      apiVersion: 'registry/2.0-token-2',
    });

    expect(tokenRequests).toBe(2);
  });
});
