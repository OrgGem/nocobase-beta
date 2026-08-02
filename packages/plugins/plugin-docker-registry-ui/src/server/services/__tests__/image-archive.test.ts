import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { extract, pack } from 'tar-stream';
import { describe, expect, it, vi } from 'vitest';
import { NCOBASE_REPOSITORY_ANNOTATION, OCI_REFERENCE_NAME_ANNOTATION } from '../../../shared/archive-metadata';
import type { Descriptor } from '../../../shared/types';
import { archiveFormat, createImageArchiveStream, dockerArchiveRepoTag, uploadImageArchive } from '../image-archive';

function digest(body: Buffer): string {
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Uint8Array) => chunks.push(Buffer.from(chunk)));
    stream.once('end', () => resolve(Buffer.concat(chunks)));
    stream.once('error', reject);
  });
}

async function tarBuffer(files: Record<string, Buffer>): Promise<Buffer> {
  const archive = pack();
  const result = collect(archive);
  for (const [name, body] of Object.entries(files)) archive.entry({ name, size: body.length }, body);
  archive.finalize();
  return result;
}

async function untar(body: Buffer): Promise<Map<string, Buffer>> {
  const output = new Map<string, Buffer>();
  const parser = extract();
  parser.on('entry', async (header, stream, next) => {
    try {
      output.set(header.name, await collect(stream));
      next();
    } catch (error) {
      parser.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  });
  await new Promise<void>((resolve, reject) => {
    parser.once('finish', resolve);
    parser.once('error', reject);
    parser.end(body);
  });
  return output;
}

describe('Docker Registry image archives', () => {
  it('uses a local Docker tag when the Registry is private', () => {
    expect(dockerArchiveRepoTag('', 'demo/alpine', 'latest')).toBe('demo/alpine:latest');
    expect(dockerArchiveRepoTag('registry.example.com', 'demo/alpine', 'latest')).toBe(
      'registry.example.com/demo/alpine:latest',
    );
  });

  it('exports a Docker-load-compatible hybrid tar without buffering remote blobs', async () => {
    const config = Buffer.from('{"architecture":"amd64","os":"linux"}');
    const layer = Buffer.from('compressed-layer');
    const configDescriptor: Descriptor = { digest: digest(config), size: config.length };
    const layerDescriptor: Descriptor = { digest: digest(layer), size: layer.length };
    const manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        config: configDescriptor,
        layers: [layerDescriptor],
      }),
    );
    const manifestDigest = digest(manifest);
    const blobs = new Map([
      [configDescriptor.digest, config],
      [layerDescriptor.digest, layer],
    ]);
    const openBlob = vi.fn(async (_repository: string, blobDigest: string) => ({
      status: 200,
      headers: {},
      stream: Readable.from(blobs.get(blobDigest) ?? Buffer.alloc(0)) as IncomingMessage,
      url: new URL(`http://registry.test/${blobDigest}`),
    }));
    const client = {
      getManifestDocument: vi.fn(async () => ({
        digest: manifestDigest,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        body: manifest,
      })),
      openBlob,
      uploadBlob: vi.fn(),
      putManifest: vi.fn(),
    };

    const archive = await createImageArchiveStream({
      client,
      repository: 'demo/alpine',
      reference: 'latest',
      format: 'docker',
      publicRegistryHost: 'localhost:15000',
      maxBytes: 1024 * 1024,
    });
    const files = await untar(await collect(archive.stream));

    expect(JSON.parse(files.get('manifest.json')?.toString('utf8') ?? '[]')).toEqual([
      {
        Config: `blobs/sha256/${configDescriptor.digest.slice(7)}`,
        RepoTags: ['localhost:15000/demo/alpine:latest'],
        Layers: [`blobs/sha256/${layerDescriptor.digest.slice(7)}`],
      },
    ]);
    expect(JSON.parse(files.get('index.json')?.toString('utf8') ?? '{}')).toMatchObject({
      manifests: [
        {
          annotations: {
            [NCOBASE_REPOSITORY_ANNOTATION]: 'demo/alpine',
            [OCI_REFERENCE_NAME_ANNOTATION]: 'latest',
          },
        },
      ],
    });
    expect(files.get(`blobs/sha256/${configDescriptor.digest.slice(7)}`)).toEqual(config);
    expect(files.get(`blobs/sha256/${layerDescriptor.digest.slice(7)}`)).toEqual(layer);
    expect(openBlob).toHaveBeenCalledTimes(2);
  });

  it('imports an OCI image-layout tar and pushes blobs before the tagged manifest', async () => {
    const config = Buffer.from('{"architecture":"amd64","os":"linux"}');
    const layer = Buffer.from('layer');
    const configDescriptor: Descriptor = {
      digest: digest(config),
      size: config.length,
      mediaType: 'application/vnd.oci.image.config.v1+json',
    };
    const layerDescriptor: Descriptor = {
      digest: digest(layer),
      size: layer.length,
      mediaType: 'application/vnd.oci.image.layer.v1.tar',
    };
    const manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        config: configDescriptor,
        layers: [layerDescriptor],
      }),
    );
    const manifestDescriptor: Descriptor = {
      digest: digest(manifest),
      size: manifest.length,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
    };
    const index = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        manifests: [
          {
            ...manifestDescriptor,
            annotations: {
              [NCOBASE_REPOSITORY_ANNOTATION]: 'demo/alpine',
              [OCI_REFERENCE_NAME_ANNOTATION]: 'roundtrip',
            },
          },
        ],
      }),
    );
    const body = await tarBuffer({
      'oci-layout': Buffer.from('{"imageLayoutVersion":"1.0.0"}'),
      'index.json': index,
      [`blobs/sha256/${manifestDescriptor.digest.slice(7)}`]: manifest,
      [`blobs/sha256/${configDescriptor.digest.slice(7)}`]: config,
      [`blobs/sha256/${layerDescriptor.digest.slice(7)}`]: layer,
    });
    const calls: string[] = [];
    const client = {
      getManifestDocument: vi.fn(),
      openBlob: vi.fn(),
      uploadBlob: vi.fn(async (_repository: string, blobDigest: string) => {
        calls.push(`blob:${blobDigest}`);
        return 'uploaded' as const;
      }),
      putManifest: vi.fn(async (_repository: string, reference: string, content: Buffer) => {
        calls.push(`manifest:${reference}`);
        return digest(content);
      }),
    };

    const result = await uploadImageArchive({
      input: Readable.from(body) as IncomingMessage,
      client,
      format: 'oci',
      maxBytes: 1024 * 1024,
      chunkSize: 1024,
      timeoutMs: 10000,
    });

    expect(result).toMatchObject({
      repository: 'demo/alpine',
      tag: 'roundtrip',
      format: 'oci',
      uploadedBlobs: 2,
      reusedBlobs: 0,
      uploadedBytes: config.length + layer.length,
      digest: manifestDescriptor.digest,
    });
    expect(calls.slice(0, 2)).toEqual([`blob:${configDescriptor.digest}`, `blob:${layerDescriptor.digest}`]);
    expect(calls[2]).toBe('manifest:roundtrip');
  });

  it('detects the destination from Docker save RepoTags when repository and tag are empty', async () => {
    const config = Buffer.from('{"architecture":"amd64","os":"linux"}');
    const layer = Buffer.from('layer');
    const body = await tarBuffer({
      'manifest.json': Buffer.from(
        JSON.stringify([
          {
            Config: 'config.json',
            RepoTags: ['registry.old.example/team/backend:1.4.2'],
            Layers: ['layer.tar'],
          },
        ]),
      ),
      'config.json': config,
      'layer.tar': layer,
    });
    const client = {
      getManifestDocument: vi.fn(),
      openBlob: vi.fn(),
      uploadBlob: vi.fn(async () => 'uploaded' as const),
      putManifest: vi.fn(async (_repository: string, _reference: string, content: Buffer) => digest(content)),
    };

    const result = await uploadImageArchive({
      input: Readable.from(body) as IncomingMessage,
      client,
      format: 'docker',
      maxBytes: 1024 * 1024,
      chunkSize: 1024,
      timeoutMs: 10000,
    });

    expect(result).toMatchObject({ repository: 'team/backend', tag: '1.4.2', format: 'docker' });
    expect(client.uploadBlob).toHaveBeenCalledTimes(2);
    expect(client.putManifest).toHaveBeenCalledWith(
      'team/backend',
      '1.4.2',
      expect.any(Buffer),
      'application/vnd.oci.image.manifest.v1+json',
    );
  });

  it('requires an explicit tag when a Docker save archive contains multiple tags', async () => {
    const body = await tarBuffer({
      'manifest.json': Buffer.from(
        JSON.stringify([
          {
            Config: 'config.json',
            RepoTags: ['team/backend:1.4.2', 'team/backend:stable'],
            Layers: ['layer.tar'],
          },
        ]),
      ),
    });
    const client = {
      getManifestDocument: vi.fn(),
      openBlob: vi.fn(),
      uploadBlob: vi.fn(),
      putManifest: vi.fn(),
    };

    await expect(
      uploadImageArchive({
        input: Readable.from(body) as IncomingMessage,
        client,
        format: 'docker',
        maxBytes: 1024 * 1024,
        chunkSize: 1024,
        timeoutMs: 10000,
      }),
    ).rejects.toMatchObject({ code: 'ARCHIVE_TAG_AMBIGUOUS', status: 422 });
    expect(client.uploadBlob).not.toHaveBeenCalled();
  });

  it('requires a repository when archive metadata does not contain one', async () => {
    const body = await tarBuffer({
      'manifest.json': Buffer.from(JSON.stringify([{ Config: 'config.json', RepoTags: null, Layers: ['layer.tar'] }])),
    });
    const client = {
      getManifestDocument: vi.fn(),
      openBlob: vi.fn(),
      uploadBlob: vi.fn(),
      putManifest: vi.fn(),
    };

    await expect(
      uploadImageArchive({
        input: Readable.from(body) as IncomingMessage,
        client,
        format: 'docker',
        maxBytes: 1024 * 1024,
        chunkSize: 1024,
        timeoutMs: 10000,
      }),
    ).rejects.toMatchObject({ code: 'ARCHIVE_REPOSITORY_REQUIRED', status: 422 });
  });

  it('rejects a Docker save archive containing multiple images even with a manual destination', async () => {
    const body = await tarBuffer({
      'manifest.json': Buffer.from(
        JSON.stringify([
          { Config: 'first.json', RepoTags: ['team/first:latest'], Layers: ['first.tar'] },
          { Config: 'second.json', RepoTags: ['team/second:latest'], Layers: ['second.tar'] },
        ]),
      ),
    });
    const client = {
      getManifestDocument: vi.fn(),
      openBlob: vi.fn(),
      uploadBlob: vi.fn(),
      putManifest: vi.fn(),
    };

    await expect(
      uploadImageArchive({
        input: Readable.from(body) as IncomingMessage,
        client,
        repository: 'manual/destination',
        tag: 'latest',
        format: 'docker',
        maxBytes: 1024 * 1024,
        chunkSize: 1024,
        timeoutMs: 10000,
      }),
    ).rejects.toMatchObject({ code: 'DOCKER_ARCHIVE_MULTIPLE_IMAGES', status: 422 });
  });

  it('rejects an OCI layout containing multiple root images', async () => {
    const body = await tarBuffer({
      'index.json': Buffer.from(
        JSON.stringify({
          schemaVersion: 2,
          manifests: [
            { digest: `sha256:${'1'.repeat(64)}`, size: 1 },
            { digest: `sha256:${'2'.repeat(64)}`, size: 1 },
          ],
        }),
      ),
    });
    const client = {
      getManifestDocument: vi.fn(),
      openBlob: vi.fn(),
      uploadBlob: vi.fn(),
      putManifest: vi.fn(),
    };

    await expect(
      uploadImageArchive({
        input: Readable.from(body) as IncomingMessage,
        client,
        repository: 'manual/destination',
        tag: 'latest',
        format: 'oci',
        maxBytes: 1024 * 1024,
        chunkSize: 1024,
        timeoutMs: 10000,
      }),
    ).rejects.toMatchObject({ code: 'OCI_ARCHIVE_MULTIPLE_IMAGES', status: 422 });
  });

  it('rejects unsupported archive format values', () => {
    expect(() => archiveFormat('zip')).toThrow('docker or oci');
  });
});
