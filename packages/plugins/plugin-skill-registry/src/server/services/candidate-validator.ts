import { RegistryError } from '../contracts/errors';
import {
  isRecord,
  type RegistrySkillCandidateV1,
  type RegistrySkillFile,
  type RegistrySourceDescriptor,
  type RegistrySourceProvider,
} from '../contracts/types';
import { ARTIFACT_LIMITS, parseArtifactLimit } from './artifact-builder';
import { candidateDigest, canonicalJson } from './canonical-json';
import { containsControlCharacters, normalizeIdentity, normalizeRelativePath } from './validation';

export const SOURCE_INGESTION_LIMITS = Object.freeze({
  maxItems: parseArtifactLimit(process.env.SKILL_REGISTRY_MAX_SOURCE_ITEMS, 1000, 10_000),
  maxFileBytes: parseArtifactLimit(
    process.env.SKILL_REGISTRY_MAX_SOURCE_FILE_BYTES,
    10 * 1024 * 1024,
    256 * 1024 * 1024,
  ),
  maxExternalKeyLength: 500,
  maxPathLength: 500,
});

function invalidCandidate(message: string): never {
  throw new RegistryError('INVALID_SOURCE_CANDIDATE', 422, message);
}

export function validateDiscoveredExternalKeys(value: unknown): string[] {
  if (!Array.isArray(value)) {
    invalidCandidate('Source provider discovery must return an array.');
  }
  if (value.length > SOURCE_INGESTION_LIMITS.maxItems) {
    throw new RegistryError('SOURCE_ITEM_LIMIT_EXCEEDED', 422, 'Source contains too many skill candidates.');
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') {
      invalidCandidate('Source provider returned a non-string external key.');
    }
    const externalKey = item.trim().normalize('NFC');
    if (
      !externalKey ||
      externalKey.length > SOURCE_INGESTION_LIMITS.maxExternalKeyLength ||
      containsControlCharacters(externalKey)
    ) {
      invalidCandidate('Source provider returned an invalid external key.');
    }
    if (seen.has(externalKey)) {
      invalidCandidate('Source provider returned duplicate external keys.');
    }
    seen.add(externalKey);
    result.push(externalKey);
  }
  return result;
}

export function validateProviderCandidate(input: {
  provider: RegistrySourceProvider;
  source: RegistrySourceDescriptor;
  externalKey: string;
  candidate: RegistrySkillCandidateV1;
}): RegistrySkillCandidateV1 {
  const { provider, source, externalKey, candidate } = input;
  if (!isRecord(candidate) || candidate.contractVersion !== 'registry-candidate/v1') {
    invalidCandidate('Source provider returned an unsupported candidate contract.');
  }
  if (
    !isRecord(candidate.source) ||
    candidate.source.provider !== provider.type ||
    candidate.source.provider !== source.providerType ||
    candidate.source.sourceId !== source.id ||
    candidate.source.externalKey !== externalKey
  ) {
    invalidCandidate('Source provider candidate identity does not match the requested source item.');
  }
  if (
    typeof candidate.source.revision !== 'string' ||
    !candidate.source.revision.trim() ||
    candidate.source.revision.length > 128 ||
    containsControlCharacters(candidate.source.revision)
  ) {
    invalidCandidate('Source provider candidate revision is invalid.');
  }
  if (
    !isRecord(candidate.identity) ||
    typeof candidate.identity.namespace !== 'string' ||
    typeof candidate.identity.slug !== 'string'
  ) {
    invalidCandidate('Source provider candidate package identity is invalid.');
  }
  const namespace = normalizeIdentity(candidate.identity.namespace, 'namespace');
  const slug = normalizeIdentity(candidate.identity.slug, 'slug');
  if (namespace !== normalizeIdentity(source.namespace, 'namespace')) {
    invalidCandidate('Source provider candidate namespace is outside the configured source namespace.');
  }
  if (!isRecord(candidate.manifest) || candidate.manifest.name !== `${namespace}/${slug}`) {
    invalidCandidate('Source provider manifest name does not match the candidate package identity.');
  }
  const manifestBytes = Buffer.byteLength(canonicalJson(candidate.manifest), 'utf8');
  if (manifestBytes > ARTIFACT_LIMITS.maxManifestBytes) {
    throw new RegistryError('ARTIFACT_TOO_LARGE', 422, 'Source candidate manifest exceeds the configured limit.');
  }
  if (!Array.isArray(candidate.files) || candidate.files.length === 0) {
    invalidCandidate('Source provider candidate must contain at least one file.');
  }
  if (candidate.files.length > Math.max(0, ARTIFACT_LIMITS.maxFiles - 1)) {
    throw new RegistryError('ARTIFACT_TOO_LARGE', 422, 'Source candidate exceeds the artifact file-count limit.');
  }
  let expandedBytes = manifestBytes;
  const files: RegistrySkillFile[] = [];
  const paths = new Set<string>();
  for (const file of candidate.files) {
    if (!isRecord(file) || typeof file.path !== 'string' || !Buffer.isBuffer(file.content)) {
      invalidCandidate('Source provider returned an invalid candidate file.');
    }
    const path = normalizeRelativePath(file.path);
    if (path !== file.path || path.length > SOURCE_INGESTION_LIMITS.maxPathLength || paths.has(path)) {
      invalidCandidate('Source provider returned a non-canonical or duplicate candidate file path.');
    }
    if (file.content.length > SOURCE_INGESTION_LIMITS.maxFileBytes) {
      throw new RegistryError('ARTIFACT_TOO_LARGE', 422, 'Source candidate contains an oversized file.');
    }
    expandedBytes += file.content.length;
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > ARTIFACT_LIMITS.maxExpandedBytes) {
      throw new RegistryError('ARTIFACT_TOO_LARGE', 422, 'Source candidate exceeds the expanded artifact limit.');
    }
    paths.add(path);
    files.push({ path, content: file.content });
  }
  const recomputedDigest = candidateDigest(candidate.manifest, files);
  if (candidate.candidateDigest !== recomputedDigest) {
    throw new RegistryError(
      'CANDIDATE_DIGEST_MISMATCH',
      422,
      'Source provider candidate bytes do not match the declared candidate digest.',
    );
  }
  return {
    ...candidate,
    source: {
      provider: provider.type,
      sourceId: source.id,
      externalKey,
      revision: candidate.source.revision.trim(),
    },
    identity: { ...candidate.identity, namespace, slug },
    files,
    candidateDigest: recomputedDigest,
  };
}
