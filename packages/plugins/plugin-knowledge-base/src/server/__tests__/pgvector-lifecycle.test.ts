// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PGVectorDatabaseProvider } from '../providers/pgvector';

const vectorMocks = vi.hoisted(() => ({ initialize: vi.fn() }));

vi.mock('@langchain/community/vectorstores/pgvector', () => ({
  PGVectorStore: { initialize: vectorMocks.initialize },
}));

function connectParams(overrides: Record<string, unknown> = {}) {
  return {
    host: '127.0.0.1',
    port: 5432,
    username: 'knowledge_base',
    password: 'test-secret',
    database: 'knowledge',
    tableName: 'kb_vectors',
    ...overrides,
  };
}

describe('PGVectorDatabaseProvider lifecycle contract', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('configures cosine similarity scores for exact matches and score thresholds', async () => {
    const store = { end: vi.fn(async () => undefined) };
    vectorMocks.initialize.mockResolvedValueOnce(store);
    const provider = new PGVectorDatabaseProvider();
    const embeddings = { modelName: 'test-embedding-model' } as never;

    await expect(provider.createVectorStore(embeddings, connectParams() as never)).resolves.toBe(store);

    expect(vectorMocks.initialize).toHaveBeenCalledWith(
      embeddings,
      expect.objectContaining({
        distanceStrategy: 'cosine',
        scoreNormalization: 'similarity',
        tableName: 'kb_vectors',
        postgresConnectionOptions: expect.objectContaining({
          host: '127.0.0.1',
          port: 5432,
          database: 'knowledge',
        }),
      }),
    );
    await provider.close();
  });

  it('reuses an identical connection and replaces the cached pool when username or password rotates', async () => {
    const firstStore = { end: vi.fn(async () => undefined) };
    const rotatedPasswordStore = { end: vi.fn(async () => undefined) };
    const rotatedUsernameStore = { end: vi.fn(async () => undefined) };
    vectorMocks.initialize
      .mockResolvedValueOnce(firstStore)
      .mockResolvedValueOnce(rotatedPasswordStore)
      .mockResolvedValueOnce(rotatedUsernameStore);
    const provider = new PGVectorDatabaseProvider();
    const embeddings = { modelName: 'test-embedding-model' } as never;
    const base = connectParams();

    const first = await provider.createVectorStore(embeddings, base as never);
    const reused = await provider.createVectorStore(embeddings, { ...base } as never);
    expect(reused).toBe(first);
    expect(vectorMocks.initialize).toHaveBeenCalledTimes(1);

    const passwordRotation = await provider.createVectorStore(
      embeddings,
      connectParams({ password: 'rotated-secret' }) as never,
    );
    expect(passwordRotation).toBe(rotatedPasswordStore);
    expect(firstStore.end).toHaveBeenCalledTimes(1);

    const usernameRotation = await provider.createVectorStore(
      embeddings,
      connectParams({ username: 'knowledge_base_rotated', password: 'rotated-secret' }) as never,
    );
    expect(usernameRotation).toBe(rotatedUsernameStore);
    expect(rotatedPasswordStore.end).toHaveBeenCalledTimes(1);
    expect(vectorMocks.initialize).toHaveBeenCalledTimes(3);

    await provider.close();
    expect(rotatedUsernameStore.end).toHaveBeenCalledTimes(1);
  });
});
