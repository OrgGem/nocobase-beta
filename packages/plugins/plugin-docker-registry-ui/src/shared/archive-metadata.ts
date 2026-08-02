import type { RegistryArchiveFormat } from './types';

export const OCI_REFERENCE_NAME_ANNOTATION = 'org.opencontainers.image.ref.name';
export const NCOBASE_REPOSITORY_ANNOTATION = 'io.nocobase.registry.repository';

const REPOSITORY_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/i;
const TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

export interface RegistryArchiveReference {
  repository?: string;
  tag?: string;
  source: 'docker' | 'oci';
  original: string;
}

export interface RegistryArchiveMetadata {
  format: RegistryArchiveFormat;
  references: RegistryArchiveReference[];
}

export interface RegistryArchiveDestinationSuggestion {
  repository?: string;
  tag?: string;
  repositoryAmbiguous: boolean;
  tagAmbiguous: boolean;
}

interface ArchiveMetadataDocuments {
  dockerManifest?: unknown;
  ociIndex?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isValidRepository(value: string): boolean {
  return REPOSITORY_PATTERN.test(value);
}

export function isValidTag(value: string): boolean {
  return TAG_PATTERN.test(value);
}

function stripSourceRegistry(repository: string): string {
  const parts = repository.split('/');
  const first = parts[0]?.toLowerCase() ?? '';
  if (parts.length > 1 && (first === 'localhost' || first.includes('.') || first.includes(':'))) {
    parts.shift();
  }
  return parts.join('/');
}

export function parseTaggedImageReference(value: string): { repository?: string; tag?: string } {
  const reference = value
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/$/, '');
  if (!reference || reference.includes('@')) return {};
  const lastSlash = reference.lastIndexOf('/');
  const lastColon = reference.lastIndexOf(':');
  if (lastColon <= lastSlash || lastColon === reference.length - 1) return {};
  const repository = stripSourceRegistry(reference.slice(0, lastColon)).toLowerCase();
  const tag = reference.slice(lastColon + 1);
  return {
    repository: isValidRepository(repository) ? repository : undefined,
    tag: isValidTag(tag) ? tag : undefined,
  };
}

function dockerReferences(value: unknown): RegistryArchiveReference[] {
  if (!Array.isArray(value)) return [];
  const references: RegistryArchiveReference[] = [];
  for (const item of value) {
    if (!isRecord(item) || !Array.isArray(item.RepoTags)) continue;
    for (const repoTag of item.RepoTags) {
      if (typeof repoTag !== 'string') continue;
      const parsed = parseTaggedImageReference(repoTag);
      if (!parsed.repository && !parsed.tag) continue;
      references.push({ ...parsed, source: 'docker', original: repoTag });
    }
  }
  return references;
}

function ociReferences(value: unknown): RegistryArchiveReference[] {
  if (!isRecord(value) || !Array.isArray(value.manifests)) return [];
  const references: RegistryArchiveReference[] = [];
  for (const manifest of value.manifests) {
    if (!isRecord(manifest) || !isRecord(manifest.annotations)) continue;
    const repositoryAnnotation = manifest.annotations[NCOBASE_REPOSITORY_ANNOTATION];
    const referenceAnnotation = manifest.annotations[OCI_REFERENCE_NAME_ANNOTATION];
    const original = typeof referenceAnnotation === 'string' ? referenceAnnotation.trim() : '';
    const parsed = original ? parseTaggedImageReference(original) : {};
    const annotatedRepository =
      typeof repositoryAnnotation === 'string' && isValidRepository(repositoryAnnotation.trim())
        ? repositoryAnnotation.trim().toLowerCase()
        : undefined;
    const standaloneTag = original && isValidTag(original) ? original : undefined;
    const repository = annotatedRepository ?? parsed.repository;
    const tag = parsed.tag ?? standaloneTag;
    if (!repository && !tag) continue;
    references.push({ repository, tag, source: 'oci', original });
  }
  return references;
}

function uniqueReferences(references: RegistryArchiveReference[]): RegistryArchiveReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.repository ?? ''}\u0000${reference.tag ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function inspectArchiveMetadataDocuments(
  documents: ArchiveMetadataDocuments,
  preferredFormat: RegistryArchiveFormat,
): RegistryArchiveMetadata {
  const docker = dockerReferences(documents.dockerManifest);
  const oci = ociReferences(documents.ociIndex);
  if (preferredFormat === 'docker' && documents.dockerManifest !== undefined) {
    return { format: 'docker', references: uniqueReferences(docker.length ? docker : oci) };
  }
  if (preferredFormat === 'oci' && documents.ociIndex !== undefined) {
    return { format: 'oci', references: uniqueReferences(oci.length ? oci : docker) };
  }
  if (documents.dockerManifest !== undefined) {
    return { format: 'docker', references: uniqueReferences(docker) };
  }
  return { format: 'oci', references: uniqueReferences(oci) };
}

function uniqueValues(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export function suggestArchiveDestination(
  metadata: RegistryArchiveMetadata,
  input: { repository?: string; tag?: string } = {},
): RegistryArchiveDestinationSuggestion {
  const requestedRepository = input.repository?.trim() || undefined;
  const requestedTag = input.tag?.trim() || undefined;
  const repositories = uniqueValues(metadata.references.map((reference) => reference.repository));
  const tags = uniqueValues(metadata.references.map((reference) => reference.tag));
  return {
    repository: requestedRepository ?? (repositories.length === 1 ? repositories[0] : undefined),
    tag: requestedTag ?? (tags.length === 1 ? tags[0] : undefined),
    repositoryAmbiguous: !requestedRepository && repositories.length > 1,
    tagAmbiguous: !requestedTag && tags.length > 1,
  };
}

export function archiveReferenceLabel(reference: RegistryArchiveReference): string {
  if (reference.repository && reference.tag) return `${reference.repository}:${reference.tag}`;
  return reference.repository ?? reference.tag ?? reference.original;
}
