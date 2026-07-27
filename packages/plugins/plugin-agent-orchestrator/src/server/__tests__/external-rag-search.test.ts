import { describe, expect, it, vi } from 'vitest';
import { createExternalRagSearchTool } from '../tools/external-rag-search';

function createToolHarness(knowledgeBase = { knowledgeBaseKeys: ['kb-allowed'] }) {
  const searchKnowledgeBases = vi.fn(async () => [
    {
      id: 'segment-1',
      content: 'Relevant deployment documentation',
      score: 0.9,
      metadata: {
        documentId: 'doc-1',
        filename: 'deployment.md',
        apiKey: 'must-not-leak',
        internalNotes: 'must-not-leak',
      },
    },
  ]);
  const repositories = {
    aiEmployees: {
      findOne: vi.fn(async () => ({ knowledgeBase })),
    },
    aiToolMessages: { findOne: vi.fn() },
    aiConversations: { findOne: vi.fn() },
  };
  const plugin = { app: { log: { error: vi.fn() } } };
  const tool = createExternalRagSearchTool(plugin);
  const ctx = {
    _currentAIEmployee: { username: 'researcher' },
    app: {
      pm: {
        get: vi.fn((name: string) => (name === 'plugin-knowledge-base' ? { searchKnowledgeBases } : undefined)),
      },
    },
    db: {
      getRepository: vi.fn((name: keyof typeof repositories) => repositories[name]),
    },
  };

  return { tool, ctx, searchKnowledgeBases, repositories };
}

describe('external_rag_search', () => {
  it('searches only knowledge bases assigned to the requesting AI Employee', async () => {
    const { tool, ctx, searchKnowledgeBases } = createToolHarness();

    const response = await tool.invoke(ctx, { query: 'deployment process' });

    expect(searchKnowledgeBases).toHaveBeenCalledWith(
      expect.objectContaining({
        _currentAIEmployee: { username: 'researcher' },
        state: expect.objectContaining({ currentAIEmployee: { username: 'researcher' } }),
      }),
      'deployment process',
      expect.objectContaining({ knowledgeBaseIds: ['kb-allowed'], rerank: true }),
    );
    expect(response.status).toBe('success');
    const content = JSON.parse(response.content) as { results: Array<{ metadata: Record<string, unknown> }> };
    expect(content.results[0].metadata).toEqual({ documentId: 'doc-1', filename: 'deployment.md' });
  });

  it('rejects explicit knowledge base IDs that are not assigned to the AI Employee', async () => {
    const { tool, ctx, searchKnowledgeBases } = createToolHarness();

    const response = await tool.invoke(ctx, {
      query: 'deployment process',
      knowledgeBaseIds: ['kb-not-allowed'],
    });

    expect(response).toEqual(
      expect.objectContaining({ status: 'error', content: expect.stringContaining('not assigned to AI Employee') }),
    );
    expect(searchKnowledgeBases).not.toHaveBeenCalled();
  });

  it('reads and de-duplicates current NocoBase knowledgeBaseIds settings', async () => {
    const { tool, ctx, searchKnowledgeBases } = createToolHarness({
      knowledgeBaseIds: ['kb-current', 'kb-current'],
    });

    const response = await tool.invoke(ctx, { query: 'deployment process' });

    expect(searchKnowledgeBases).toHaveBeenCalledWith(
      expect.any(Object),
      'deployment process',
      expect.objectContaining({ knowledgeBaseIds: ['kb-current'] }),
    );
    expect(response.status).toBe('success');
  });

  it('resolves the AI Employee from the tool call when runtime context has no employee', async () => {
    const { tool, ctx, searchKnowledgeBases, repositories } = createToolHarness();
    delete ctx._currentAIEmployee;
    repositories.aiToolMessages.findOne.mockResolvedValue({ sessionId: 'session-1' });
    repositories.aiConversations.findOne.mockResolvedValue({ aiEmployeeUsername: 'researcher' });

    const response = await tool.invoke(ctx, { query: 'deployment process' }, { toolCallId: 'tool-call-1' });

    expect(repositories.aiToolMessages.findOne).toHaveBeenCalledWith({ filter: { toolCallId: 'tool-call-1' } });
    expect(repositories.aiConversations.findOne).toHaveBeenCalledWith({ filter: { sessionId: 'session-1' } });
    expect(searchKnowledgeBases).toHaveBeenCalledWith(
      expect.objectContaining({ _currentAIEmployee: { username: 'researcher' } }),
      'deployment process',
      expect.objectContaining({ knowledgeBaseIds: ['kb-allowed'] }),
    );
    expect(response.status).toBe('success');
  });
});
