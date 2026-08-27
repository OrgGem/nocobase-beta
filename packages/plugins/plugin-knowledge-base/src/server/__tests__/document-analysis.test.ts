import { describe, expect, it, vi } from 'vitest';
import { analyzeDocumentText, buildShingleHash, DuplicateDetectionService } from '../services/document-analysis';

describe('analyzeDocumentText', () => {
  it('extracts keywords and word count', () => {
    const text = 'Knowledge base systems store knowledge. The knowledge base helps users find knowledge quickly.';
    const result = analyzeDocumentText(text);

    expect(result.wordCount).toBeGreaterThan(0);
    expect(result.keywords).toContain('knowledge');
    // stop words filtered
    expect(result.keywords).not.toContain('the');
  });

  it('produces identical fingerprints for identical text and different for changed text', () => {
    const a = 'The quick brown fox jumps over the lazy dog near the river bank every morning.';
    const b = 'The quick brown fox jumps over the lazy dog near the river bank every morning.';
    const c = 'Something completely different about database administration tasks.';

    expect(buildShingleHash(a)).toBe(buildShingleHash(b));
    expect(buildShingleHash(a)).not.toBe(buildShingleHash(c));
  });
});

describe('DuplicateDetectionService.findDuplicates', () => {
  function makeDb(docs: Array<{ id: string; textContent: string }>) {
    return {
      getRepository: vi.fn((name: string) => {
        if (name === 'aiKnowledgeBaseDocuments') {
          return {
            find: vi.fn(async () => docs.map((d) => ({ id: d.id, toJSON() { return this; } }))),
            findOne: vi.fn(async ({ filter }: any) => {
              const doc = docs.find((d) => d.id === filter?.id);
              if (!doc) return null;
              return {
                id: doc.id,
                get(key: string) {
                  return (this as unknown as Record<string, unknown>)[key];
                },
                textContent: doc.textContent,
              };
            }),
          };
        }
        return {};
      }),
    } as never;
  }

  it('flags exact duplicates above threshold', async () => {
    const same = 'This is a repeated paragraph about deployment processes and rollback strategies used by the platform team.';
    const db = makeDb([
      { id: 'doc-1', textContent: same },
      { id: 'doc-2', textContent: same },
      { id: 'doc-3', textContent: 'Entirely different content regarding quarterly budget reviews.' },
    ]);
    const service = new DuplicateDetectionService(db);

    const pairs = await service.findDuplicates('kb-1', 0.9);

    expect(pairs).toHaveLength(1);
    expect(pairs[0].documentId).toBe('doc-1');
    expect(pairs[0].otherDocumentId).toBe('doc-2');
    expect(pairs[0].similarity).toBeGreaterThanOrEqual(0.9);
  });

  it('returns empty list when no duplicates exist', async () => {
    const db = makeDb([
      { id: 'doc-a', textContent: 'Alpha content about cats and their habits in the garden during spring time.' },
      { id: 'doc-b', textContent: 'Beta documentation covering server maintenance windows and alert routing rules.' },
    ]);
    const service = new DuplicateDetectionService(db);

    const pairs = await service.findDuplicates('kb-1', 0.9);
    expect(pairs).toEqual([]);
  });
});