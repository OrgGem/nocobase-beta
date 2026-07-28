import { mkdtemp, mkdir, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { RegistryError } from '../contracts/errors';
import { sha256 } from '../services/canonical-json';
import { FilesystemArtifactStore } from '../services/filesystem-artifact-store';

describe('FilesystemArtifactStore concurrency and integrity', () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    for (const root of temporaryRoots.splice(0)) {
      await rm(root, { force: true, recursive: true });
    }
  });

  async function createStore(): Promise<FilesystemArtifactStore> {
    const root = await mkdtemp(join(tmpdir(), 'skill-registry-store-'));
    temporaryRoots.push(root);
    return new FilesystemArtifactStore(root);
  }

  it('atomically converges concurrent puts of the same digest', async () => {
    const store = await createStore();
    const content = Buffer.from('deterministic artifact bytes');
    const digest = sha256(content);

    const results = await Promise.all(Array.from({ length: 16 }, () => store.put(digest, content)));

    expect(new Set(results.map((result) => result.storageKey))).toEqual(new Set([store.keyForDigest(digest)]));
    await expect(store.read(store.keyForDigest(digest))).resolves.toEqual(content);
    const files = await readdir(dirname(store.absolutePath(store.keyForDigest(digest))));
    expect(files).toEqual([`${digest.slice('sha256:'.length)}.zip`]);
  });

  it('rejects an existing same-size file whose bytes do not match the addressed digest', async () => {
    const store = await createStore();
    const expected = Buffer.from('expected-content');
    const tampered = Buffer.from('tampered-content');
    expect(tampered).toHaveLength(expected.length);
    const digest = sha256(expected);
    const destination = store.absolutePath(store.keyForDigest(digest));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, tampered);

    await expect(store.put(digest, expected)).rejects.toMatchObject({
      code: 'ARTIFACT_DIGEST_MISMATCH',
      status: 409,
    } satisfies Partial<RegistryError>);
  });

  it('keeps a new digest generation safe from a stale remover of the old generation', async () => {
    const store = await createStore();
    const content = Buffer.from('generation-fenced artifact');
    const digest = sha256(content);
    const oldStorageKey = store.keyForDigestGeneration(digest, '00000000-0000-4000-8000-000000000001');
    const newStorageKey = store.keyForDigestGeneration(digest, '00000000-0000-4000-8000-000000000002');

    await store.putAt(oldStorageKey, digest, content);
    await store.putAt(newStorageKey, digest, content);
    await store.remove(oldStorageKey);

    expect(oldStorageKey).not.toBe(newStorageKey);
    expect(store.isKeyForDigest(newStorageKey, digest)).toBe(true);
    await expect(store.read(newStorageKey)).resolves.toEqual(content);
  });

  it('verifies the canonical storage key, size, and bytes before returning a download', async () => {
    const store = await createStore();
    const content = Buffer.from('verified artifact');
    const digest = sha256(content);
    const stored = await store.put(digest, content);

    await expect(store.readVerified(stored.storageKey, digest, content.length)).resolves.toEqual(content);
    await expect(store.readVerified('sha256/ff/ff/fake.zip', digest, content.length)).rejects.toMatchObject({
      code: 'ARTIFACT_DIGEST_MISMATCH',
    });

    const opened = await store.openVerified(stored.storageKey, digest, content.length);
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks)).toEqual(content);
    expect(opened.sizeBytes).toBe(content.length);

    await writeFile(store.absolutePath(stored.storageKey), Buffer.from('tampered artifact'));
    await expect(store.readVerified(stored.storageKey, digest, content.length)).rejects.toMatchObject({
      code: 'ARTIFACT_DIGEST_MISMATCH',
    });
    await expect(store.openVerified(stored.storageKey, digest, content.length)).rejects.toMatchObject({
      code: 'ARTIFACT_DIGEST_MISMATCH',
    });
  });
});
