import AdmZip from 'adm-zip';
import { Buffer as NodeBuffer } from 'node:buffer';

import { isRecord, type RegistrySkillCandidateV1, type RegistrySkillManifestV1 } from '../contracts/types';
import { RegistryError } from '../contracts/errors';
import { canonicalJson, sha256 } from './canonical-json';
import { normalizeRelativePath } from './validation';

export function parseArtifactLimit(
  value: string | undefined,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const normalized = value?.trim();
  if (!normalized || !/^[1-9]\d*$/.test(normalized)) {
    return fallback;
  }
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : fallback;
}

// Getter-based limits re-read env vars on every access, so runtime settings
// applied via applyRuntimeOverrides() take effect without a server restart.
export const ARTIFACT_LIMITS = {
  get maxFiles() {
    return parseArtifactLimit(process.env.SKILL_REGISTRY_MAX_FILES, 10000);
  },
  get maxExpandedBytes() {
    return parseArtifactLimit(process.env.SKILL_REGISTRY_MAX_EXPANDED_BYTES, 1024 * 1024 * 1024);
  },
  get maxArtifactBytes() {
    return parseArtifactLimit(process.env.SKILL_REGISTRY_MAX_ARTIFACT_BYTES, 500 * 1024 * 1024);
  },
  get maxManifestBytes() {
    return parseArtifactLimit(process.env.SKILL_REGISTRY_MAX_MANIFEST_BYTES, 50 * 1024 * 1024);
  },
  get maxInstructionBytes() {
    return parseArtifactLimit(process.env.SKILL_REGISTRY_MAX_INSTRUCTION_BYTES, 50 * 1024 * 1024);
  },
} as const;
const DETERMINISTIC_ZIP_TIME = new Date('1980-01-01T00:00:00.000Z');
const MANIFEST_PATH = 'manifest.json';
const MANIFEST_PATH_KEY = MANIFEST_PATH.toLowerCase();
const INSTRUCTION_PATH_KEY = 'skill.md';

export interface BuiltArtifact {
  content: Buffer;
  digest: string;
  manifestDigest: string;
  expandedSizeBytes: number;
}

function pathCollisionKey(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

function validateManifest(manifest: unknown): asserts manifest is RegistrySkillManifestV1 {
  if (!isRecord(manifest)) {
    throw new RegistryError('INVALID_MANIFEST', 422, 'Artifact manifest.json must be an object.');
  }
  if (manifest.schemaVersion !== 'registry.skill.nocobase.io/v1') {
    throw new RegistryError('INVALID_MANIFEST', 422, 'Unsupported skill manifest schemaVersion.');
  }
  if (
    typeof manifest.name !== 'string' ||
    !manifest.name.trim() ||
    typeof manifest.displayName !== 'string' ||
    !manifest.displayName.trim() ||
    !isRecord(manifest.runtime) ||
    typeof manifest.runtime.entrypoint !== 'string' ||
    !manifest.runtime.entrypoint.trim()
  ) {
    throw new RegistryError('INVALID_MANIFEST', 422, 'Manifest requires displayName and runtime.entrypoint.');
  }
  if (typeof manifest.runtime.kind !== 'string' || !['python', 'node', 'instruction'].includes(manifest.runtime.kind)) {
    throw new RegistryError('INVALID_MANIFEST', 422, 'Manifest runtime.kind must be python, node, or instruction.');
  }
}

export function buildArtifact(candidate: RegistrySkillCandidateV1): BuiltArtifact {
  validateManifest(candidate.manifest);
  const maxFiles = ARTIFACT_LIMITS.maxFiles;
  const maxExpandedBytes = ARTIFACT_LIMITS.maxExpandedBytes;
  const maxArtifactBytes = ARTIFACT_LIMITS.maxArtifactBytes;
  const maxManifestBytes = ARTIFACT_LIMITS.maxManifestBytes;
  const maxInstructionBytes = ARTIFACT_LIMITS.maxInstructionBytes;
  const maximumCandidateFiles = Math.max(0, maxFiles - 1);
  if (candidate.files.length === 0 || candidate.files.length > maximumCandidateFiles) {
    throw new RegistryError(
      'ARTIFACT_TOO_LARGE',
      422,
      `Artifact must contain between 1 and ${maximumCandidateFiles} candidate files; manifest.json counts toward the ${maxFiles}-file limit.`,
    );
  }

  const manifestJson = canonicalJson(candidate.manifest);
  const manifestData = Buffer.from(manifestJson, 'utf8');
  if (manifestData.length > maxManifestBytes) {
    throw new RegistryError('ARTIFACT_TOO_LARGE', 422, 'Artifact manifest.json exceeds the configured limit.');
  }
  const entrypoint = normalizeRelativePath(candidate.manifest.runtime.entrypoint);
  const files = [...candidate.files]
    .map((file) => {
      if (!Buffer.isBuffer(file.content)) {
        throw new RegistryError('INVALID_MANIFEST', 422, `Artifact file ${file.path} does not contain binary data.`);
      }
      return { path: normalizeRelativePath(file.path), content: file.content };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const filePaths = new Set<string>();
  const collisionKeys = new Set<string>();
  let expandedSizeBytes = manifestData.length;

  if (expandedSizeBytes > maxExpandedBytes) {
    throw new RegistryError('ARTIFACT_TOO_LARGE', 422, 'Artifact expanded size exceeds the configured limit.');
  }

  for (const file of files) {
    const collisionKey = pathCollisionKey(file.path);
    if (collisionKey === MANIFEST_PATH_KEY) {
      throw new RegistryError(
        'ARTIFACT_UNSAFE_PATH',
        422,
        `${MANIFEST_PATH} is generated by the registry and cannot be supplied by a candidate.`,
      );
    }
    if (collisionKeys.has(collisionKey)) {
      throw new RegistryError(
        'ARTIFACT_UNSAFE_PATH',
        422,
        `Artifact has a case-insensitive or Unicode-normalized path collision at ${file.path}.`,
      );
    }
    filePaths.add(file.path);
    collisionKeys.add(collisionKey);
    if (collisionKey === INSTRUCTION_PATH_KEY && file.content.length > maxInstructionBytes) {
      throw new RegistryError('ARTIFACT_TOO_LARGE', 422, 'Artifact SKILL.md exceeds the configured limit.');
    }
    expandedSizeBytes += file.content.length;
    if (expandedSizeBytes > maxExpandedBytes) {
      throw new RegistryError('ARTIFACT_TOO_LARGE', 422, 'Artifact expanded size exceeds the configured limit.');
    }
  }

  if (!filePaths.has(entrypoint)) {
    throw new RegistryError('INVALID_MANIFEST', 422, `Entrypoint ${entrypoint} is not included in the artifact.`);
  }

  const archive = new AdmZip();
  const manifestEntry = archive.addFile(MANIFEST_PATH, manifestData, '', 0o644);
  manifestEntry.header.time = DETERMINISTIC_ZIP_TIME;
  for (const file of files) {
    const entry = archive.addFile(file.path, file.content, '', 0o644);
    entry.header.time = DETERMINISTIC_ZIP_TIME;
  }
  let content: Buffer;
  try {
    content = archive.toBuffer();
  } catch {
    throw new RegistryError('ARTIFACT_TOO_LARGE', 422, 'Failed to build artifact ZIP archive.');
  }
  if (content.length > maxArtifactBytes) {
    throw new RegistryError('ARTIFACT_TOO_LARGE', 422, 'Artifact compressed size exceeds the configured limit.');
  }
  return {
    content,
    digest: sha256(content),
    manifestDigest: sha256(manifestJson),
    expandedSizeBytes,
  };
}

export function unpackArtifact(content: Buffer): { manifest: RegistrySkillManifestV1; files: Map<string, Buffer> } {
  const maxFiles = ARTIFACT_LIMITS.maxFiles;
  const maxExpandedBytes = ARTIFACT_LIMITS.maxExpandedBytes;
  const maxArtifactBytes = ARTIFACT_LIMITS.maxArtifactBytes;
  const maxManifestBytes = ARTIFACT_LIMITS.maxManifestBytes;
  const maxInstructionBytes = ARTIFACT_LIMITS.maxInstructionBytes;
  if (content.length > maxArtifactBytes) {
    throw new RegistryError('ARTIFACT_TOO_LARGE', 422, 'Artifact compressed size exceeds the configured limit.');
  }
  // Normalize through node:buffer so adm-zip's internal `instanceof
  // Uint8Array` checks work even when the caller comes from a jsdom realm.
  const archive = new AdmZip(NodeBuffer.from(content));
  const files = new Map<string, Buffer>();
  const collisionKeys = new Set<string>();
  let expandedSizeBytes = 0;
  for (const entry of archive.getEntries()) {
    const entryName = entry.entryName.replace(/\\/g, '/');
    // ZIP directory entries are identified by a trailing separator. Relying on
    // adm-zip's `isDirectory` is not portable because supported releases expose
    // it as either a boolean getter or a method.
    const isDirectory = entryName.endsWith('/');
    const path = normalizeRelativePath(isDirectory && entryName.endsWith('/') ? entryName.slice(0, -1) : entryName);
    const collisionKey = pathCollisionKey(path);
    if (collisionKeys.has(collisionKey)) {
      throw new RegistryError(
        'ARTIFACT_UNSAFE_PATH',
        422,
        `Artifact has a case-insensitive or Unicode-normalized path collision at ${path}.`,
      );
    }
    if (collisionKey === MANIFEST_PATH_KEY && path !== MANIFEST_PATH) {
      throw new RegistryError(
        'ARTIFACT_UNSAFE_PATH',
        422,
        `Artifact manifest must use the exact path ${MANIFEST_PATH}.`,
      );
    }
    collisionKeys.add(collisionKey);
    if (isDirectory) {
      continue;
    }
    if (files.size >= maxFiles) {
      throw new RegistryError('ARTIFACT_TOO_LARGE', 422, 'Artifact exceeds extraction limits.');
    }
    // Reject on the declared size BEFORE decompressing, or a zip bomb entry would be
    // fully expanded into memory just to find out it is too large.
    const entryLimit = collisionKey === MANIFEST_PATH_KEY ? maxManifestBytes : maxExpandedBytes;
    if (
      !Number.isSafeInteger(entry.header.size) ||
      entry.header.size < 0 ||
      entry.header.size > entryLimit ||
      (collisionKey === INSTRUCTION_PATH_KEY && entry.header.size > maxInstructionBytes) ||
      expandedSizeBytes + entry.header.size > maxExpandedBytes
    ) {
      throw new RegistryError('ARTIFACT_TOO_LARGE', 422, 'Artifact exceeds extraction limits.');
    }
    // Normalize cross-realm Uint8Array values so string decoding and the public
    // return type behave consistently in Node, jsdom tests, and bundled runtime.
    const data = NodeBuffer.from(entry.getData());
    // Declared sizes can lie; re-check with the actual decompressed bytes.
    expandedSizeBytes += data.length;
    if (
      data.length > entryLimit ||
      (collisionKey === INSTRUCTION_PATH_KEY && data.length > maxInstructionBytes) ||
      expandedSizeBytes > maxExpandedBytes
    ) {
      throw new RegistryError('ARTIFACT_TOO_LARGE', 422, 'Artifact exceeds extraction limits.');
    }
    files.set(path, data);
  }
  const manifestData = files.get(MANIFEST_PATH);
  if (!manifestData) {
    throw new RegistryError('INVALID_MANIFEST', 422, `Artifact does not contain ${MANIFEST_PATH}.`);
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestData.toString('utf8'));
  } catch {
    throw new RegistryError('INVALID_MANIFEST', 422, 'Artifact manifest.json is not valid JSON.');
  }
  validateManifest(manifest);
  const entrypoint = normalizeRelativePath(manifest.runtime.entrypoint);
  if (!files.has(entrypoint)) {
    throw new RegistryError('INVALID_MANIFEST', 422, 'Artifact entrypoint is missing.');
  }
  return { manifest, files };
}
