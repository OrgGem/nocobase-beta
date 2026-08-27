import { describe, expect, it, vi } from 'vitest';
import aiKnowledgeBase from '../resources/ai-knowledge-base';

describe('aiKnowledgeBase.submitSearchFeedback', () => {
  it('rejects missing query/knowledgeBaseId/feedback', async () => {
    const ctx: any = {
      action: { params: { values: {} } },
      throw: vi.fn(),
    };

    await aiKnowledgeBase.actions.submitSearchFeedback(ctx, vi.fn());

    expect(ctx.throw).toHaveBeenCalledWith(400, 'query, knowledgeBaseId and feedback are required');
  });

  it('stores feedback for accessible KB', async () => {
    const create = vi.fn();
    const ctx: any = {
      action: {
        params: {
          values: {
            knowledgeBaseId: 'kb-1',
            query: 'deployment process',
            documentId: 'doc-1',
            feedback: 'positive',
            rerankScore: 0.9,
          },
        },
      },
      auth: { user: { id: 7 } },
      state: {},
      app: { acl: { getRole: vi.fn() } },
      db: {
        getRepository: vi.fn((name: string) => {
          if (name === 'aiKnowledgeBases') {
            return {
              find: vi.fn(async () => [{ id: 'kb-1' }]),
              findOne: vi.fn(),
            };
          }
          return { create };
        }),
      },
      throw: vi.fn(),
      body: null,
    };
    const next = vi.fn();

    await aiKnowledgeBase.actions.submitSearchFeedback(ctx, next);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        values: expect.objectContaining({
          knowledgeBaseId: 'kb-1',
          feedback: 'positive',
          userId: '7',
        }),
      }),
    );
    expect(next).toHaveBeenCalled();
  });

  it('returns 404 for inaccessible KB', async () => {
    const ctx: any = {
      action: {
        params: {
          values: {
            knowledgeBaseId: 'kb-secret',
            query: 'q',
            feedback: 'negative',
          },
        },
      },
      auth: { user: { id: 7 } },
      state: {},
      app: { acl: { getRole: vi.fn() } },
      db: {
        getRepository: vi.fn(() => ({
          find: vi.fn(async () => []),
          create: vi.fn(),
        })),
      },
      throw: vi.fn(),
    };
    const next = vi.fn();

    await aiKnowledgeBase.actions.submitSearchFeedback(ctx, next);

    expect(ctx.throw).toHaveBeenCalledWith(404, 'Knowledge base not found');
    expect(next).not.toHaveBeenCalled();
  });
});
