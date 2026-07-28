import { createHash, randomUUID } from 'crypto';
import { createReadStream, type ReadStream } from 'fs';
import { mkdir, open as openFile, readFile, rename, stat, unlink, writeFile } from 'fs/promises';
import { dirname, resolve, sep } from 'path';

import { RegistryError } from '../contracts/errors';
import { sha256 } from './canonical-json';

const DIGEST_PATTERN = /^sha256:([a-f0-9]{64})$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
  );
}

function verificationTimeoutMs(): number {
  const value = process.env.SKILL_REGISTRY_ARTIFACT_VERIFY_TIMEOUT_MS?.trim();
  if (!value || !/^[1-9]\d*$/.test(value)) {
    return 60_000;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= 5 * 60 * 1000 ? parsed : 60_000;
}

export class FilesystemArtifactStore {
  readonly rootPath: string;

  constructor(
    rootPath = process.env.SKILL_REGISTRY_STORAGE_PATH || resolve(process.cwd(), 'storage', 'skill-registry'),
  ) {
    this.rootPath = resolve(rootPath);
  }

  keyForDigest(digest: string): string {
    const match = digest.match(DIGEST_PATTERN);
    if (!match) {
      throw new RegistryError('ARTIFACT_DIGEST_MISMATCH', 422, 'Artifact digest is invalid.');
    }
    // Storage keys are persisted in the database, so keep them platform-neutral.
    // `path.join()` would write backslashes on Windows and make the same row
    // unusable by a Linux replica mounting the shared artifact volume.
    return ['sha256', match[1].slice(0, 2), match[1].slice(2, 4), `${match[1]}.zip`].join('/');
  }

  keyForDigestGeneration(digest: string, generation = randomUUID()): string {
    const canonical = this.keyForDigest(digest);
    if (!UUID_PATTERN.test(generation)) {
      throw new RegistryError('ARTIFACT_DIGEST_MISMATCH', 422, 'Artifact generation is invalid.');
    }
    return canonical.replace(/\.zip$/, `-${generation}.zip`);
  }

  isKeyForDigest(storageKey: string, digest: string): boolean {
    const canonical = this.keyForDigest(digest);
    const normalized = storageKey.replace(/\\/g, '/');
    if (normalized === canonical) {
      return true;
    }
    const escapedCanonical = canonical.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\.zip$/, '');
    return new RegExp(
      `^${escapedCanonical}-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.zip$`,
      'i',
    ).test(normalized);
  }

  absolutePath(storageKey: string): string {
    const path = resolve(this.rootPath, storageKey);
    if (!path.startsWith(`${this.rootPath}${sep}`)) {
      throw new RegistryError(
        'ARTIFACT_UNSAFE_PATH',
        422,
        'Artifact storage key is outside the registry storage root.',
      );
    }
    return path;
  }

  async put(digest: string, content: Buffer): Promise<{ storageKey: string; sizeBytes: number }> {
    return this.putAt(this.keyForDigest(digest), digest, content);
  }

  async putAt(storageKey: string, digest: string, content: Buffer): Promise<{ storageKey: string; sizeBytes: number }> {
    if (sha256(content) !== digest) {
      throw new RegistryError('ARTIFACT_DIGEST_MISMATCH', 422, 'Artifact bytes do not match their digest.');
    }
    if (!this.isKeyForDigest(storageKey, digest)) {
      throw new RegistryError(
        'ARTIFACT_DIGEST_MISMATCH',
        422,
        'Artifact storage key is not bound to its content digest.',
      );
    }
    const destination = this.absolutePath(storageKey);
    await mkdir(dirname(destination), { recursive: true });
    try {
      const existing = await readFile(destination);
      if (sha256(existing) !== digest) {
        throw new RegistryError('ARTIFACT_DIGEST_MISMATCH', 409, 'Existing artifact bytes do not match their digest.');
      }
      return { storageKey, sizeBytes: existing.length };
    } catch (error) {
      if (error instanceof RegistryError) {
        throw error;
      }
      if (!isMissingFileError(error)) {
        throw error;
      }
    }

    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { flag: 'wx' });
    try {
      await rename(temporary, destination);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      const existing = await readFile(destination).catch(() => undefined);
      if (!existing || sha256(existing) !== digest) {
        throw error;
      }
    }
    // Verify the exact destination bytes after the atomic rename. This catches
    // storage corruption before a database row can publish the artifact.
    const persisted = await readFile(destination);
    if (sha256(persisted) !== digest) {
      throw new RegistryError('ARTIFACT_DIGEST_MISMATCH', 409, 'Persisted artifact bytes do not match their digest.');
    }
    return { storageKey, sizeBytes: persisted.length };
  }

  async ensureReady(): Promise<void> {
    await mkdir(this.rootPath, { recursive: true });
    const root = await stat(this.rootPath);
    if (!root.isDirectory()) {
      throw new RegistryError('ARTIFACT_STORAGE_UNAVAILABLE', 503, 'Artifact storage root is not a directory.');
    }
  }

  open(storageKey: string) {
    return createReadStream(this.absolutePath(storageKey));
  }

  async read(storageKey: string): Promise<Buffer> {
    const path = this.absolutePath(storageKey);
    return readFile(path);
  }

  async readVerified(storageKey: string, digest: string, expectedSizeBytes?: number): Promise<Buffer> {
    if (!this.isKeyForDigest(storageKey, digest)) {
      throw new RegistryError(
        'ARTIFACT_DIGEST_MISMATCH',
        409,
        'Artifact storage key is not bound to its content digest.',
      );
    }
    const content = await this.read(storageKey);
    if (
      (expectedSizeBytes !== undefined &&
        (!Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes < 0 || content.length !== expectedSizeBytes)) ||
      sha256(content) !== digest
    ) {
      throw new RegistryError('ARTIFACT_DIGEST_MISMATCH', 409, 'Stored artifact bytes failed digest verification.');
    }
    return content;
  }

  async openVerified(
    storageKey: string,
    digest: string,
    expectedSizeBytes?: number,
  ): Promise<{ stream: ReadStream; sizeBytes: number }> {
    if (!this.isKeyForDigest(storageKey, digest)) {
      throw new RegistryError(
        'ARTIFACT_DIGEST_MISMATCH',
        409,
        'Artifact storage key is not bound to its content digest.',
      );
    }
    const handle = await openFile(this.absolutePath(storageKey), 'r');
    try {
      const before = await handle.stat();
      if (
        !before.isFile() ||
        (expectedSizeBytes !== undefined &&
          (!Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes < 0 || before.size !== expectedSizeBytes))
      ) {
        throw new RegistryError('ARTIFACT_DIGEST_MISMATCH', 409, 'Stored artifact size failed verification.');
      }
      const hash = createHash('sha256');
      const verifier = handle.createReadStream({ autoClose: false, start: 0 });
      const timeout = setTimeout(() => {
        verifier.destroy(
          new RegistryError('ARTIFACT_STORAGE_UNAVAILABLE', 503, 'Artifact verification exceeded its timeout.'),
        );
      }, verificationTimeoutMs());
      try {
        for await (const chunk of verifier) {
          hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
      } finally {
        clearTimeout(timeout);
      }
      const after = await handle.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || `sha256:${hash.digest('hex')}` !== digest) {
        throw new RegistryError('ARTIFACT_DIGEST_MISMATCH', 409, 'Stored artifact bytes failed digest verification.');
      }
      return { stream: handle.createReadStream({ autoClose: true, start: 0 }), sizeBytes: after.size };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  async remove(storageKey: string): Promise<void> {
    try {
      await unlink(this.absolutePath(storageKey));
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
  }
}
