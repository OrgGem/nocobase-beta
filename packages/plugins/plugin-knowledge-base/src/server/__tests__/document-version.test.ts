import { describe, expect, it, vi } from 'vitest';
import { DocumentVersionService } from '../services/document-version';

function createMockRepo() {
  const store: any[] = [];
  let nextId = 1;
  return {
    store,
    async find({ filter, sort, limit, offset }: any = {}) {
      let rows = [...store];
      if (typeof offset === 'number' && offset > 0) {
        rows = rows.slice(offset);
      }
      if (filter?.documentId) {
        rows = rows.filter((r) => r.documentId === filter.documentId);
      }
      if (Array.isArray(sort) && sort[0] === '-version') {
        rows.sort((a, b) => b.version - a.version);
      }
      return typeof limit === 'number' ? rows.slice(0, limit) : rows;
    },
    async findOne({ filter }: any = {}) {
      return store.find((r) => r.documentId === filter?.documentId && r.version === filter?.version) ?? null;
    },
    async create({ values }: any) {
      const record = {
        id: nextId++,
        ...values,
        get(key: string) {
          return (this as unknown as Record<string, unknown>)[key];
        },
      };
      store.push(record);
      return record;
    },
    async destroy({ filter }: any) {
      const ids: any[] = filter?.id?.$in ?? [];
      for (const id of ids) {
        const idx = store.findIndex((r) => r.id === id);
        if (idx >= 0) store.splice(idx, 1);
      }
    },
  };
}

function createService() {
  const versionsRepo = createMockRepo();
  const db = {
    getRepository: vi.fn((name: string) => (name === 'aiKnowledgeBaseDocumentVersions' ? versionsRepo : {})),
  } as never;
  return { service: new DocumentVersionService(db), repo: versionsRepo };
}

describe('DocumentVersionService', () => {
  it('creates the first version with changeType initial', async () => {
    const { service, repo } = createService();

    const version = await service.recordVersion({
      documentId: 'doc-1',
      textContent: 'hello world',
      changeType: 'initial',
    });

    expect(version).toBe(1);
    expect(repo.store).toHaveLength(1);
  });

  it('skips duplicate snapshots for identical content', async () => {
    const { service } = createService();

    await service.recordVersion({ documentId: 'doc-2', textContent: 'same', changeType: 'initial' });
    const second = await service.recordVersion({ documentId: 'doc-2', textContent: 'same', changeType: 'update' });

    expect(second).toBeNull();
  });

  it('creates a new version when content changes', async () => {
    const { service } = createService();

    await service.recordVersion({ documentId: 'doc-3', textContent: 'v1 content', changeType: 'initial' });
    const next = await service.recordVersion({ documentId: 'doc-3', textContent: 'v2 content', changeType: 'update' });

    expect(next).toBe(2);
  });

  it('restoreVersion rejects missing versions', async () => {
    const docFindOne = vi.fn(async () => null);
    const versionsRepo = createMockRepo();
    const db = {
      getRepository: vi.fn((name: string) => {
        if (name === 'aiKnowledgeBaseDocuments') {
          return { findOne: docFindOne };
        }
        return versionsRepo;
      }),
    } as never;
    const service = new DocumentVersionService(db);

    const result = await service.restoreVersion('doc-x', 99);

    expect(result.restored).toBe(false);
    expect(result.error).toContain('not found');
  });
});
