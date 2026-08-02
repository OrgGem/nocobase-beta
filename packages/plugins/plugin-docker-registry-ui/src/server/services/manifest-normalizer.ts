import type { Descriptor, NormalizedManifest } from '../../shared/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asDescriptor(value: unknown): Descriptor | undefined {
  if (!isRecord(value) || typeof value.digest !== 'string') return undefined;
  const annotations = isRecord(value.annotations)
    ? Object.fromEntries(
        Object.entries(value.annotations).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      )
    : undefined;
  const platform = isRecord(value.platform)
    ? {
        architecture: typeof value.platform.architecture === 'string' ? value.platform.architecture : undefined,
        os: typeof value.platform.os === 'string' ? value.platform.os : undefined,
        variant: typeof value.platform.variant === 'string' ? value.platform.variant : undefined,
      }
    : undefined;
  return {
    digest: value.digest,
    mediaType: typeof value.mediaType === 'string' ? value.mediaType : undefined,
    artifactType: typeof value.artifactType === 'string' ? value.artifactType : undefined,
    size: typeof value.size === 'number' ? value.size : undefined,
    annotations,
    platform,
  };
}

function descriptors(value: unknown): Descriptor[] {
  if (!Array.isArray(value)) return [];
  return value.map(asDescriptor).filter((item): item is Descriptor => Boolean(item));
}

export function normalizeManifest(
  payload: unknown,
  contentType: string | undefined,
  digest: string,
): NormalizedManifest {
  const raw = isRecord(payload) ? payload : {};
  const mediaType = contentType?.split(';')[0].trim() || (typeof raw.mediaType === 'string' ? raw.mediaType : '');
  const manifests = descriptors(raw.manifests);
  if (manifests.length > 0) {
    return { kind: 'index', mediaType, digest, manifests, raw };
  }

  const layers = descriptors(raw.layers);
  const config = asDescriptor(raw.config);
  if (layers.length > 0 || config) {
    return {
      kind: 'image',
      mediaType,
      digest,
      config,
      layers,
      size: layers.reduce((total, layer) => total + (layer.size ?? 0), 0),
      raw,
    };
  }

  if (raw.schemaVersion === 1) {
    return { kind: 'legacy', mediaType, digest, raw };
  }

  return { kind: 'unknown', mediaType, digest, raw };
}

export function mergeImageConfig(manifest: NormalizedManifest, configData: unknown): NormalizedManifest {
  if (manifest.kind !== 'image' || !isRecord(configData)) return manifest;
  const config = isRecord(configData.config) ? configData.config : {};
  return {
    ...manifest,
    created: typeof configData.created === 'string' ? configData.created : undefined,
    architecture: typeof configData.architecture === 'string' ? configData.architecture : undefined,
    os: typeof configData.os === 'string' ? configData.os : undefined,
    configData: { ...configData, config },
  };
}
