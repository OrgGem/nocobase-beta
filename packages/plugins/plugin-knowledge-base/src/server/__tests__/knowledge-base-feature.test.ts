import { describe, expect, it, vi } from 'vitest';
import type { SearchOptions } from '@nocobase/plugin-ai';
import requestContext from '../request-context';
import { KnowledgeBaseFeatureImpl } from '../features/knowledge-base-impl';

describe('KnowledgeBaseFeatureImpl.search', () => {
  it('uses the active request and AI Employee identity for native retrieval', async () => {
    const searchKnowledgeBases = vi.fn(async () => [
      {
        id: 'segment-1',
        content: 'Relevant knowledge',
        metadata: { documentId: 'doc-1' },
        rerankScore: 0.87,
      },
    ]);
    const plugin = {
      app: { logger: { warn: vi.fn() } },
      searchKnowledgeBases,
    };
    const feature = new KnowledgeBaseFeatureImpl(plugin as never);
    const ctx = { state: { currentUser: { id: 7 } } };
    const options: SearchOptions = {
      knowledgeBaseKeys: ['kb-1'],
      query: '  deployment process  ',
      topK: 3,
      score: '0.5',
    };

    const results = await requestContext.run({ ctx, agentUsername: 'researcher' }, () => feature.search(options));

    expect(searchKnowledgeBases).toHaveBeenCalledWith(
      expect.objectContaining({
        _currentAIEmployee: { username: 'researcher' },
        state: expect.objectContaining({ currentAIEmployee: { username: 'researcher' } }),
      }),
      'deployment process',
      {
        knowledgeBaseIds: ['kb-1'],
        topK: 3,
        scoreThreshold: 0.5,
        rerank: true,
      },
    );
    expect(results).toEqual([
      {
        id: 'segment-1',
        content: 'Relevant knowledge',
        metadata: { documentId: 'doc-1' },
        score: 0.87,
      },
    ]);
  });

  it('fails closed when native retrieval has no request context', async () => {
    const plugin = {
      app: { logger: { warn: vi.fn() } },
      searchKnowledgeBases: vi.fn(),
    };
    const feature = new KnowledgeBaseFeatureImpl(plugin as never);

    await expect(feature.search({ knowledgeBaseKeys: ['kb-1'], query: 'deployment process' })).resolves.toEqual([]);
    expect(plugin.searchKnowledgeBases).not.toHaveBeenCalled();
  });
});
