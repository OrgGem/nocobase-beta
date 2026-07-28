import type { RegistrySkillManifestV1 } from '../contracts/types';
import { RegistryError } from '../contracts/errors';
import { unpackArtifact } from './artifact-builder';
import { canonicalJson, sha256 } from './canonical-json';
import { normalizeRelativePath } from './validation';

export interface ArtifactManifestBinding {
  packageName: string;
  version: string;
  runtime: string;
  entrypoint: string;
  manifest: unknown;
  manifestDigest: string;
  artifactManifestDigest: string;
}

function bindingMismatch(message: string): never {
  throw new RegistryError('ARTIFACT_DIGEST_MISMATCH', 409, message);
}

export function verifyArtifactBinding(
  content: Buffer,
  expected: ArtifactManifestBinding,
): {
  manifest: RegistrySkillManifestV1;
  files: Map<string, Buffer>;
} {
  const unpacked = unpackArtifact(content);
  const extractedManifestDigest = sha256(canonicalJson(unpacked.manifest));
  if (extractedManifestDigest !== expected.manifestDigest) {
    bindingMismatch('Extracted manifest.json does not match the published manifest digest.');
  }
  let storedManifestDigest: string;
  try {
    storedManifestDigest = sha256(canonicalJson(expected.manifest));
  } catch {
    bindingMismatch('Stored version manifest is not canonicalizable.');
  }
  if (storedManifestDigest !== expected.manifestDigest) {
    bindingMismatch('Stored version manifest does not match its published manifest digest.');
  }
  if (expected.artifactManifestDigest !== expected.manifestDigest) {
    bindingMismatch('Artifact and version records disagree on the published manifest digest.');
  }
  if (unpacked.manifest.name !== expected.packageName) {
    bindingMismatch('Artifact manifest package identity does not match the published package.');
  }
  if (unpacked.manifest.version !== expected.version) {
    bindingMismatch('Artifact manifest version does not match the published version.');
  }
  if (unpacked.manifest.runtime.kind !== expected.runtime) {
    bindingMismatch('Artifact manifest runtime does not match the published runtime.');
  }
  if (normalizeRelativePath(unpacked.manifest.runtime.entrypoint) !== normalizeRelativePath(expected.entrypoint)) {
    bindingMismatch('Artifact manifest entrypoint does not match the published entrypoint.');
  }
  return unpacked;
}
