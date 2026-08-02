import { describe, expect, it } from 'vitest';
import { mergeImageConfig, normalizeManifest } from '../manifest-normalizer';

describe('manifest normalizer', () => {
  it('normalizes a Docker image manifest and its configuration', () => {
    const manifest = normalizeManifest(
      {
        schemaVersion: 2,
        mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
        config: { digest: 'sha256:config', size: 12 },
        layers: [
          { digest: 'sha256:layer-a', size: 10 },
          { digest: 'sha256:layer-b', size: 20 },
        ],
      },
      'application/vnd.docker.distribution.manifest.v2+json',
      'sha256:manifest',
    );
    const withConfig = mergeImageConfig(manifest, {
      architecture: 'amd64',
      os: 'linux',
      created: '2026-01-01T00:00:00.000Z',
      config: { Cmd: ['node', 'server.js'] },
    });

    expect(withConfig.kind).toBe('image');
    if (withConfig.kind !== 'image') return;
    expect(withConfig.size).toBe(30);
    expect(withConfig.config?.digest).toBe('sha256:config');
    expect(withConfig.architecture).toBe('amd64');
    expect(withConfig.configData?.config).toEqual({ Cmd: ['node', 'server.js'] });
  });

  it('normalizes an OCI image index without treating it as a layered image', () => {
    const manifest = normalizeManifest(
      {
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.index.v1+json',
        manifests: [
          {
            mediaType: 'application/vnd.oci.image.manifest.v1+json',
            digest: 'sha256:linux-amd64',
            size: 701,
            platform: { os: 'linux', architecture: 'amd64' },
          },
        ],
      },
      'application/vnd.oci.image.index.v1+json',
      'sha256:index',
    );

    expect(manifest.kind).toBe('index');
    if (manifest.kind !== 'index') return;
    expect(manifest.manifests[0]).toMatchObject({
      digest: 'sha256:linux-amd64',
      platform: { os: 'linux', architecture: 'amd64' },
    });
  });

  it('keeps a legacy schema 1 manifest readable without pretending it is schema 2', () => {
    const manifest = normalizeManifest(
      { schemaVersion: 1, name: 'legacy/image' },
      'application/vnd.docker.distribution.manifest.v1+json',
      'sha256:legacy',
    );
    expect(manifest.kind).toBe('legacy');
  });
});
