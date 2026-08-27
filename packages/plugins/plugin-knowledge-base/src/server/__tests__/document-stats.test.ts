import { describe, expect, it, vi } from 'vitest';
import documentsResource from '../resources/ai-knowledge-base-documents';

describe('aiKnowledgeBaseDoc.stats', () => {
  it('returns zeroed stats when non-admin has no accessible KBs', async () => {
    const ctx: any = {
      action: { params: {} },
      auth: { user: { id: 7 } },
      state: {},
      app: { acl: { getRole: vi.fn() } },
      db: {
        getRepository: vi.fn((name: string) => {
          if (name === 'aiKnowledgeBases') {
            return { find: vi.fn(async () => []) };
          }
          return { find: vi.fn() };
        }),
      },
      throw: vi.fn(),
      body: null,
    };
    const next = vi.fn();

    await documentsResource.actions.stats(ctx, next);

    expect(ctx.body).toEqual({ total: 0, pending: 0, processing: 0, success: 0, failed: 0, retrying: 0 });
    expect(next).toHaveBeenCalled();
  });

  it('counts document statuses', async () => {
    const docs = [
      { get: () => 'pending' },
      { get: () => 'processing' },
      { get: () => 'success' },
      { get: () => 'success' },
      { get: () => 'failed' },
    ];
    const ctx: any = {
      action: { params: {} },
      auth: { user: { id: 1, roles: ['root'] } },
      state: { currentRoles: ['root'] },
      app: { acl: { getRole: vi.fn(() => ({ getStrategy: () => ({ allowConfigure: true }) })) } },
      db: {
        getRepository: vi.fn((name: string) => {
          if (name === 'aiKnowledgeBaseDocuments') {
            return { find: vi.fn(async () => docs) };
          }
          return {};
        }),
      },
      throw: vi.fn(),
      body: null,
    };
    const next = vi.fn();

    await documentsResource.actions.stats(ctx, next);

    expect(ctx.body).toEqual({ total: 5, pending: 1, processing: 1, success: 2, failed: 1, retrying: 0 });
    expect(next).toHaveBeenCalled();
  });
});

describe('aiKnowledgeBase.list document appends', () => {
  it('returns accurate document count placeholders for the navigator', async () => {
    const { default: knowledgeBaseResource } = await import('../resources/ai-knowledge-base');
    const knowledgeBaseFind = vi.fn(async () => [{ get: () => 'kb-1', toJSON: () => ({ id: 'kb-1', name: 'KB 1' }) }]);
    const documentFind = vi.fn(async () => [{ get: () => 'kb-1' }, { get: () => 'kb-1' }, { get: () => 'kb-2' }]);
    const ctx: any = {
      action: { params: { appends: ['documents'] } },
      auth: { user: { id: 1, roles: ['root'] } },
      state: { currentRoles: ['root'] },
      app: { acl: { getRole: vi.fn(() => ({ getStrategy: () => ({ allowConfigure: true }) })) } },
      db: {
        getRepository: vi.fn((name: string) =>
          name === 'aiKnowledgeBases' ? { find: knowledgeBaseFind } : { find: documentFind },
        ),
      },
      body: null,
    };
    const next = vi.fn();

    await knowledgeBaseResource.actions.list(ctx, next);

    expect(knowledgeBaseFind).toHaveBeenCalledWith(
      expect.objectContaining({ appends: expect.arrayContaining(['vectorStore', 'documents']) }),
    );
    expect(documentFind).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { knowledgeBaseId: { $in: ['kb-1'] } }, fields: ['knowledgeBaseId'] }),
    );
    expect(ctx.body).toEqual([expect.objectContaining({ id: 'kb-1', documents: [{}, {}] })]);
    expect(next).toHaveBeenCalled();
  });
});
