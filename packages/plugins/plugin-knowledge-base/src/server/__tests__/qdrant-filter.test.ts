import { describe, expect, it } from 'vitest';
import { toQdrantMetadataFilter } from '../features/vector-store-provider-impl';

describe('toQdrantMetadataFilter', () => {
  it('translates internal metadata filters to Qdrant query DSL', () => {
    expect(
      toQdrantMetadataFilter({
        knowledgeBaseOuterId: { in: ['kb-1', 'kb-2'] },
        userId: 'user-1',
      }),
    ).toEqual({
      must: [
        { key: 'metadata.knowledgeBaseOuterId', match: { any: ['kb-1', 'kb-2'] } },
        { key: 'metadata.userId', match: { value: 'user-1' } },
      ],
    });
  });

  it('preserves an explicitly supplied Qdrant DSL filter', () => {
    const filter = { must: [{ key: 'metadata.documentId', match: { value: 'document-1' } }] };

    expect(toQdrantMetadataFilter(filter)).toBe(filter);
  });
});
