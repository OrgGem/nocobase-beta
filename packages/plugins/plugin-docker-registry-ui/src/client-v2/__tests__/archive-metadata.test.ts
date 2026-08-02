import { describe, expect, it } from 'vitest';
import {
  inspectArchiveMetadataDocuments,
  NCOBASE_REPOSITORY_ANNOTATION,
  OCI_REFERENCE_NAME_ANNOTATION,
  parseTaggedImageReference,
  suggestArchiveDestination,
} from '../../shared/archive-metadata';
import { inspectImageArchiveFile } from '../archive-metadata';

function writeTarText(target: Uint8Array, offset: number, value: string) {
  target.set(new TextEncoder().encode(value), offset);
}

function metadataTar(name: string, value: unknown): File {
  const body = new TextEncoder().encode(JSON.stringify(value));
  const header = new Uint8Array(512);
  writeTarText(header, 0, name);
  writeTarText(header, 124, `${body.length.toString(8).padStart(11, '0')}\0`);
  const padding = new Uint8Array(Math.ceil(body.length / 512) * 512 - body.length);
  const parts = [header, body, padding, new Uint8Array(1024)];
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return {
    size: bytes.length,
    slice(start = 0, end = bytes.length) {
      const selected = bytes.slice(start, end);
      return {
        arrayBuffer: async () => selected.buffer,
        text: async () => new TextDecoder().decode(selected),
      } as unknown as Blob;
    },
  } as File;
}

describe('Registry archive destination metadata', () => {
  it('removes the source Registry host and port from Docker RepoTags', () => {
    expect(parseTaggedImageReference('localhost:15000/team/backend:1.4.2')).toEqual({
      repository: 'team/backend',
      tag: '1.4.2',
    });
    expect(parseTaggedImageReference('docker.io/library/alpine:latest')).toEqual({
      repository: 'library/alpine',
      tag: 'latest',
    });
  });

  it('detects one Docker save destination and preserves manual overrides', () => {
    const metadata = inspectArchiveMetadataDocuments(
      {
        dockerManifest: [
          {
            RepoTags: ['registry.old.example/team/backend:1.4.2'],
          },
        ],
      },
      'docker',
    );

    expect(suggestArchiveDestination(metadata)).toEqual({
      repository: 'team/backend',
      tag: '1.4.2',
      repositoryAmbiguous: false,
      tagAmbiguous: false,
    });
    expect(suggestArchiveDestination(metadata, { repository: 'release/backend', tag: 'stable' })).toMatchObject({
      repository: 'release/backend',
      tag: 'stable',
    });
  });

  it('does not choose a tag when the Docker archive contains multiple tags', () => {
    const metadata = inspectArchiveMetadataDocuments(
      { dockerManifest: [{ RepoTags: ['team/backend:1.4.2', 'team/backend:stable'] }] },
      'docker',
    );

    expect(suggestArchiveDestination(metadata)).toEqual({
      repository: 'team/backend',
      tag: undefined,
      repositoryAmbiguous: false,
      tagAmbiguous: true,
    });
  });

  it('detects repository and tag annotations from an OCI image layout', () => {
    const metadata = inspectArchiveMetadataDocuments(
      {
        ociIndex: {
          manifests: [
            {
              annotations: {
                [NCOBASE_REPOSITORY_ANNOTATION]: 'team/backend',
                [OCI_REFERENCE_NAME_ANNOTATION]: '1.4.2',
              },
            },
          ],
        },
      },
      'oci',
    );

    expect(suggestArchiveDestination(metadata)).toMatchObject({
      repository: 'team/backend',
      tag: '1.4.2',
    });
  });

  it('reads Docker RepoTags directly from a selected TAR file', async () => {
    const file = metadataTar('manifest.json', [{ RepoTags: ['source.example/team/backend:2.0.0'] }]);

    const metadata = await inspectImageArchiveFile(file, 'docker');

    expect(suggestArchiveDestination(metadata)).toMatchObject({
      repository: 'team/backend',
      tag: '2.0.0',
    });
  });
});
