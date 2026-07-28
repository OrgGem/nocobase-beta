import { createHash } from 'crypto';

import { RegistryError } from '../contracts/errors';

function canonicalize(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RegistryError('INVALID_MANIFEST', 422, 'Manifest contains a non-finite number.');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  throw new RegistryError('INVALID_MANIFEST', 422, 'Manifest contains an unsupported value.');
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

export function sha256(value: Buffer | string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function candidateDigest(manifest: unknown, files: Array<{ path: string; content: Buffer }>): string {
  const fileList = [...files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => ({ path: file.path, sha256: sha256(file.content) }));
  return sha256(canonicalJson({ manifest, files: fileList }));
}
