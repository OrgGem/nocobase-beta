// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import aiKnowledgeBase from '../resources/ai-knowledge-base';

function createThrow() {
  return vi.fn((status: number, message: string) => {
    throw Object.assign(new Error(message), { status });
  });
}

describe('aiKnowledgeBase.submitSearchFeedback', () => {
  it('rejects missing query/knowledgeBaseId/feedback', async () => {
    const throwRequest = createThrow();
    const ctx: any = {
      action: { params: { values: {} } },
      t: (key: string) => key,
      throw: throwRequest,
    };

    await expect(aiKnowledgeBase.actions.submitSearchFeedback(ctx, vi.fn())).rejects.toMatchObject({
      status: 400,
      message: 'A valid single record ID is required',
    });

    expect(throwRequest).toHaveBeenCalledWith(400, 'A valid single record ID is required');
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
      t: (key: string) => key,
      throw: createThrow(),
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
    const throwRequest = createThrow();
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
      t: (key: string) => key,
      throw: throwRequest,
    };
    const next = vi.fn();

    await expect(aiKnowledgeBase.actions.submitSearchFeedback(ctx, next)).rejects.toMatchObject({
      status: 404,
      message: 'Knowledge base not found',
    });

    expect(throwRequest).toHaveBeenCalledWith(404, 'Knowledge base not found');
    expect(next).not.toHaveBeenCalled();
  });
});
