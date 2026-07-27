import { describe, expect, it } from 'vitest';
import { buildKnowledgeAccessMatrix, summarizeRetrievalSpan } from '../resources/agent-knowledge-insights';

describe('agent knowledge insights', () => {
  it('explains assignment and explicit agent-policy decisions per employee and knowledge base', () => {
    const matrix = buildKnowledgeAccessMatrix(
      [
        {
          username: 'researcher',
          knowledgeBase: { knowledgeBaseKeys: ['kb-public', 'kb-explicit'] },
          roles: [{ name: 'research' }],
        },
      ],
      [
        { id: 'kb-public', name: 'Public docs', enabled: true, agentAccess: 'inherit', accessLevel: 'PUBLIC' },
        {
          id: 'kb-explicit',
          name: 'Restricted docs',
          enabled: true,
          agentAccess: 'explicit',
          allowedRoles: ['research'],
          accessLevel: 'SHARED',
        },
        { id: 'kb-unassigned', name: 'Unassigned docs', enabled: true, agentAccess: 'inherit' },
        { id: 'kb-disabled', name: 'Disabled docs', enabled: false, agentAccess: 'inherit' },
      ],
    );

    expect(matrix).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ knowledgeBaseId: 'kb-public', access: 'allowed', assigned: true }),
        expect.objectContaining({
          knowledgeBaseId: 'kb-explicit',
          access: 'allowed',
          reason: expect.stringContaining('role'),
        }),
        expect.objectContaining({
          knowledgeBaseId: 'kb-unassigned',
          access: 'denied',
          reason: expect.stringContaining('not assigned'),
        }),
        expect.objectContaining({
          knowledgeBaseId: 'kb-disabled',
          access: 'denied',
          reason: expect.stringContaining('disabled'),
        }),
      ]),
    );
    expect(matrix.find((row) => row.knowledgeBaseId === 'kb-explicit')?.userGate).toContain('allowed KB role');
  });

  it('reads current NocoBase knowledgeBaseIds settings and removes duplicate assignments', () => {
    const matrix = buildKnowledgeAccessMatrix(
      [
        {
          username: 'current-config-agent',
          knowledgeBase: { knowledgeBaseIds: ['kb-current', 'kb-current'] },
        },
      ],
      [{ id: 'kb-current', name: 'Current configuration', enabled: true, agentAccess: 'inherit' }],
    );

    expect(matrix).toEqual([
      expect.objectContaining({
        employeeUsername: 'current-config-agent',
        knowledgeBaseId: 'kb-current',
        assigned: true,
        access: 'allowed',
      }),
    ]);
  });

  it('returns a citation-only view of external RAG spans and never surfaces raw metadata', () => {
    const trace = summarizeRetrievalSpan({
      id: 42,
      employeeUsername: 'researcher',
      status: 'success',
      input: { query: 'deployment' },
      output: JSON.stringify({
        query: 'deployment',
        results: [
          {
            knowledgeBaseId: 'kb-public',
            knowledgeBaseName: 'Public docs',
            content: 'Use the deployment checklist before release.',
            score: 0.98,
            source: { id: 'document-1', filename: 'deploy.md', url: 'https://example.test/deploy.md' },
            metadata: { apiKey: 'must-not-appear' },
          },
        ],
      }),
    });

    expect(trace).toMatchObject({
      id: 42,
      decision: 'allowed',
      query: 'deployment',
      citations: [
        {
          knowledgeBaseId: 'kb-public',
          filename: 'deploy.md',
          score: 0.98,
        },
      ],
    });
    expect(JSON.stringify(trace)).not.toContain('must-not-appear');
  });

  it('records a denial reason when the retrieval tool fails', () => {
    const trace = summarizeRetrievalSpan({
      status: 'error',
      input: { query: 'private notes' },
      error: 'Knowledge base is not assigned to this AI Employee.',
    });

    expect(trace).toMatchObject({
      decision: 'denied',
      query: 'private notes',
      reason: 'Knowledge base is not assigned to this AI Employee.',
      citations: [],
    });
  });
});
