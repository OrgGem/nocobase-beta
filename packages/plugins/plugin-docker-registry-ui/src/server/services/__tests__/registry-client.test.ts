import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    hasPassword: false,
    hasBearerToken: false,
    hasClientPrivateKey: false,
    hasClientPrivateKeyPassphrase: false,
  };
}

describe('RegistryClient', () => {
  let server: Server;
  let registryUrl: string;
  let deletedDigest: string | undefined;
  let temporaryDirectory: string;
  let uploadedBlob = Buffer.alloc(0);
  let uploadedManifestReference: string | undefined;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'docker-registry-client-'));
    uploadedBlob = Buffer.alloc(0);
    uploadedManifestReference = undefined;
    server = createServer((request, response) => {
      if (request.method === 'GET' && request.url === '/v2/') {
        response.writeHead(200, { 'Docker-Distribution-API-Version': 'registry/2.0' });
        response.end();
        return;
      }
      if (request.method === 'GET' && request.url === '/v2/_catalog?n=100') {
        response.writeHead(200, {
          'Content-Type': 'application/json',
          Link: `<${registryUrl}/v2/_catalog?n=100&last=team%2Fapi>; rel="next"`,
        });
        response.end(JSON.stringify({ repositories: ['team/api'] }));
        return;
      }
      if (request.method === 'GET' && request.url === '/v2/_catalog?n=100&last=team%2Fapi') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ repositories: ['team/worker'] }));
        return;
      }
      if (request.method === 'GET' && request.url === '/v2/team/api/tags/list?n=100') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ name: 'team/api', tags: ['latest', 'stable'] }));
        return;
      }
      if (
        request.method === 'HEAD' &&
        ['/v2/team/api/manifests/latest', '/v2/team/api/manifests/stable'].includes(request.url ?? '')
      ) {
        response.writeHead(200, { 'Docker-Content-Digest': 'sha256:manifest' });
        response.end();
        return;
      }
      if (request.method === 'GET' && request.url === '/v2/team/api/manifests/latest') {
        response.writeHead(200, {
          'Content-Type': 'application/vnd.oci.image.manifest.v1+json',
          'Docker-Content-Digest': 'sha256:manifest',
        });
        response.end(
          JSON.stringify({
            schemaVersion: 2,
            mediaType: 'application/vnd.oci.image.manifest.v1+json',
            config: { digest: 'sha256:config', size: 20 },
            layers: [{ digest: 'sha256:layer', size: 100 }],
          }),
        );
        return;
      }
      if (request.method === 'GET' && request.url === '/v2/team/api/manifests/legacy') {
        response.writeHead(200, {
          'Content-Type': 'application/vnd.docker.distribution.manifest.v1+json',
          'Docker-Content-Digest': 'sha256:legacy',
        });
        response.end(JSON.stringify({ schemaVersion: 1, name: 'team/api' }));
        return;
      }
      if (request.method === 'GET' && request.url === '/v2/team/api/blobs/sha256%3Aconfig') {
        response.writeHead(307, { Location: `${registryUrl}/blob-storage/config` });
        response.end();
        return;
      }
      if (request.method === 'GET' && request.url === '/blob-storage/config') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            created: '2026-01-01T00:00:00.000Z',
            architecture: 'amd64',
            os: 'linux',
            config: { Cmd: ['node', 'server.js'] },
          }),
        );
        return;
      }
      if (request.method === 'GET' && request.url === '/v2/team/api/referrers/sha256%3Amanifest') {
        response.writeHead(200, { 'Content-Type': 'application/vnd.oci.image.index.v1+json' });
        response.end(
          JSON.stringify({
            schemaVersion: 2,
            mediaType: 'application/vnd.oci.image.index.v1+json',
            manifests: [
              {
                mediaType: 'application/vnd.oci.image.manifest.v1+json',
                artifactType: 'application/vnd.dev.cosign.simplesigning.v1+json',
                digest: 'sha256:signature',
                size: 321,
              },
            ],
          }),
        );
        return;
      }
      if (request.method === 'DELETE' && request.url === '/v2/team/api/manifests/sha256%3Amanifest') {
        deletedDigest = 'sha256:manifest';
        response.writeHead(202);
        response.end();
        return;
      }
      if (request.method === 'POST' && request.url === '/v2/new/project/blobs/uploads/') {
        response.writeHead(202, { Location: '/v2/new/project/blobs/uploads/session-1' });
        response.end();
        return;
      }
      if (request.method === 'PATCH' && request.url === '/v2/new/project/blobs/uploads/session-1') {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          uploadedBlob = Buffer.concat([uploadedBlob, ...chunks]);
          response.writeHead(202, { Location: '/v2/new/project/blobs/uploads/session-1' });
          response.end();
        });
        return;
      }
      if (
        request.method === 'PUT' &&
        request.url?.startsWith('/v2/new/project/blobs/uploads/session-1?digest=sha256%3A')
      ) {
        response.writeHead(201);
        response.end();
        return;
      }
      if (request.method === 'PUT' && request.url === '/v2/new/project/manifests/latest') {
        uploadedManifestReference = request.url;
        response.writeHead(201, { 'Docker-Content-Digest': 'sha256:new-manifest' });
        response.end();
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
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('uses the V2 endpoint for health and exposes Registry pagination', async () => {
    const client = new RegistryClient(settings(registryUrl));
    await expect(client.health()).resolves.toMatchObject({
      reachable: true,
      authentication: 'public',
      apiVersion: 'registry/2.0',
    });
    await expect(client.listRepositories()).resolves.toEqual({ items: ['team/api'], nextCursor: 'team/api' });
    await expect(client.listRepositories(undefined, 'worker')).resolves.toEqual({ items: ['team/worker'] });
  });

  it('requires explicit confirmation before deleting a manifest shared by multiple tags', async () => {
    const client = new RegistryClient(settings(registryUrl));
    await expect(client.deleteTag('team/api', 'latest')).rejects.toMatchObject({
      code: 'SHARED_MANIFEST_CONFIRMATION_REQUIRED',
    });
    await expect(client.deleteTag('team/api', 'latest', 'sha256:manifest', true)).resolves.toEqual({
      digest: 'sha256:manifest',
      tags: ['latest', 'stable'],
    });
    expect(deletedDigest).toBe('sha256:manifest');
  });

  it('previews and deletes repository contents by unique manifest digest', async () => {
    const client = new RegistryClient(settings(registryUrl));
    await expect(client.getRepositoryDeleteImpact('team/api')).resolves.toEqual({
      repository: 'team/api',
      tags: ['latest', 'stable'],
      manifests: [{ digest: 'sha256:manifest', tags: ['latest', 'stable'] }],
      unresolvedTags: [],
      signature: 'sha256:manifest',
    });
    await expect(client.deleteRepositoryContents('team/api', 'sha256:manifest')).rejects.toMatchObject({
      code: 'REPOSITORY_CONFIRMATION_REQUIRED',
    });
    await expect(client.deleteRepositoryContents('team/api', 'sha256:stale', true)).rejects.toMatchObject({
      code: 'REPOSITORY_CONTENTS_CHANGED',
    });
    await expect(client.deleteRepositoryContents('team/api', 'sha256:manifest', true)).resolves.toMatchObject({
      deletedDigests: ['sha256:manifest'],
      tags: ['latest', 'stable'],
    });
    expect(deletedDigest).toBe('sha256:manifest');
  });

  it('follows blob redirects, reads OCI referrers and blocks legacy manifests when disabled', async () => {
    const client = new RegistryClient(settings(registryUrl));
    await expect(client.getImageDetails('team/api', 'latest')).resolves.toMatchObject({
      kind: 'image',
      architecture: 'amd64',
      referrersSupported: true,
      referrers: [
        {
          artifactType: 'application/vnd.dev.cosign.simplesigning.v1+json',
          digest: 'sha256:signature',
        },
      ],
    });
    await expect(client.getImageDetails('team/api', 'legacy')).rejects.toMatchObject({
      status: 415,
      code: 'LEGACY_SCHEMA_DISABLED',
    });
  });

  it('uploads blobs and a manifest without requiring the destination repository to exist first', async () => {
    const client = new RegistryClient(settings(registryUrl));
    const content = Buffer.from('content for a repository created by the first push');
    const filePath = join(temporaryDirectory, 'blob');
    const blobDigest = `sha256:${'a'.repeat(64)}`;
    await writeFile(filePath, content);

    await expect(client.uploadBlob('new/project', blobDigest, filePath, content.length, 7)).resolves.toBe('uploaded');
    await expect(
      client.putManifest(
        'new/project',
        'latest',
        Buffer.from('{"schemaVersion":2}'),
        'application/vnd.oci.image.manifest.v1+json',
      ),
    ).resolves.toBe('sha256:new-manifest');

    expect(uploadedBlob).toEqual(content);
    expect(uploadedManifestReference).toBe('/v2/new/project/manifests/latest');
  });
});
