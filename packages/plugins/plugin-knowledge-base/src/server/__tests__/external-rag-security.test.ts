import { describe, expect, it, vi } from 'vitest';
import { createOpenAICompatibleRagStrategy } from '../providers/external-rag';
import aiKnowledgeBase from '../resources/ai-knowledge-base';
import { KnowledgeSearchService } from '../services/knowledge-search';

describe('openai-compatible External RAG security', () => {
  it('rejects a loopback endpoint before resolving LLM credentials or sending a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const findOne = vi.fn();
    const strategy = createOpenAICompatibleRagStrategy({
      db: { getRepository: () => ({ findOne }) },
      app: { environment: { renderJsonTemplate: vi.fn() } },
    });

    await expect(
      strategy(
        'deployment process',
        {
          id: 'kb-1',
          options: {
            ragApiUrl: 'http://127.0.0.1:3000/search',
            ragProvider: 'openai-compatible',
          },
        },
        {},
      ),
    ).rejects.toThrow('cannot point to localhost');

    expect(findOne).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('denies non-administrators from creating a provider that forwards central LLM credentials', async () => {
    const create = vi.fn();
    const next = vi.fn();
    const ctx = {
      action: {
        params: {
          values: {
            type: 'EXTERNAL_RAG',
            options: { ragProvider: 'openai-compatible' },
          },
        },
      },
      auth: { user: { id: 7, roles: ['member'] } },
      state: { currentRoles: ['member'] },
      app: { acl: { getRole: vi.fn() } },
      db: { getRepository: vi.fn(() => ({ create })) },
      t: vi.fn((key: string) => `translated:${key}`),
      throw: vi.fn(),
    };

    await aiKnowledgeBase.actions.create(ctx as never, next);

    expect(ctx.throw).toHaveBeenCalledWith(
      403,
      'translated:Only administrators can configure External RAG providers that forward LLM credentials.',
    );
    expect(create).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('does not execute credential-forwarding External RAG searches for non-administrators', async () => {
    const strategy = vi.fn();
    const plugin = {
      db: {
        getRepository: vi.fn(() => ({
          find: vi.fn(async () => [
            {
              id: 'kb-1',
              name: 'Forwarding KB',
              type: 'EXTERNAL_RAG',
              options: { ragProvider: 'openai-compatible' },
              toJSON() {
                return this;
              },
            },
          ]),
        })),
      },
      app: { logger: { warn: vi.fn(), error: vi.fn() } },
      getRagSearchStrategy: vi.fn(() => strategy),
      knowledgeBaseFeature: { getKnowledgeBaseGroup: vi.fn() },
      vectorStoreProvider: { createVectorStoreService: vi.fn() },
    };
    const search = new KnowledgeSearchService(plugin);
    const ctx = {
      auth: { user: { id: 7, roles: ['member'] } },
      state: { currentRoles: ['member'] },
      app: { acl: { getRole: vi.fn() } },
    };

    await expect(search.search(ctx as never, 'deployment process')).resolves.toEqual([]);
    expect(strategy).not.toHaveBeenCalled();
    expect(plugin.app.logger.warn).toHaveBeenCalledWith(expect.stringContaining('credential-forwarding External RAG'));
  });
});
