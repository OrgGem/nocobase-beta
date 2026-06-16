import { describe, expect, it, vi } from 'vitest';
import { AgentRegistryService } from '../services/AgentRegistryService';

function createService(configs: Array<{ leaderUsername: string; subAgentUsername: string }>) {
  const find = vi.fn(async () => configs);
  const service = new AgentRegistryService({
    db: {
      getRepository: vi.fn(() => ({ find })),
    },
  });
  return { service, find };
}

function createServiceWithEmployees(employees: Record<string, any>) {
  const findOne = vi.fn(async ({ filter }: { filter: { username: string } }) => employees[filter.username] ?? null);
  const service = new AgentRegistryService({
    db: {
      getRepository: vi.fn(() => ({ findOne })),
    },
  });
  return { service, findOne };
}

describe('AgentRegistryService', () => {
  describe('isRegisteredDelegationTool', () => {
    it('matches sanitized delegate tool names without parsing username delimiters', async () => {
      const { service } = createService([
        {
          leaderUsername: 'lead.to_team',
          subAgentUsername: 'qa_to_review',
        },
      ]);

      await expect(service.isRegisteredDelegationTool('delegate_lead_to_team_to_qa_to_review')).resolves.toBe(true);
    });

    it('matches dispatch tools by generated sanitized name', async () => {
      const { service } = createService([
        {
          leaderUsername: 'lead.to team',
          subAgentUsername: 'researcher',
        },
      ]);

      await expect(service.isRegisteredDelegationTool('dispatch_subagents_lead_to_team')).resolves.toBe(true);
    });

    it('keeps legacy alias valid only when one enabled config matches the sub-agent', async () => {
      const single = createService([
        {
          leaderUsername: 'lead-a',
          subAgentUsername: 'qa.to review',
        },
      ]);
      await expect(single.service.isRegisteredDelegationTool('delegate_to_qa_to_review')).resolves.toBe(true);

      const ambiguous = createService([
        {
          leaderUsername: 'lead-a',
          subAgentUsername: 'qa.to review',
        },
        {
          leaderUsername: 'lead-b',
          subAgentUsername: 'qa.to review',
        },
      ]);
      await expect(ambiguous.service.isRegisteredDelegationTool('delegate_to_qa_to_review')).resolves.toBe(false);
    });
  });

  describe('resolveModelSettings', () => {
    it('reads the dedicated models[] array shape saved by the admin UI', async () => {
      const { service } = createServiceWithEmployees({
        sub: {
          username: 'sub',
          modelSettings: {
            enabled: true,
            llmService: undefined,
            model: undefined,
            models: [{ llmService: 'openai', model: 'gpt-4o' }],
          },
        },
      });

      await expect(service.resolveModelSettings('sub')).resolves.toEqual({
        llmService: 'openai',
        model: 'gpt-4o',
      });
    });

    it('falls back to the flat legacy { llmService, model } shape', async () => {
      const { service } = createServiceWithEmployees({
        sub: {
          username: 'sub',
          modelSettings: { llmService: 'anthropic', model: 'claude-3-5' },
        },
      });

      await expect(service.resolveModelSettings('sub')).resolves.toEqual({
        llmService: 'anthropic',
        model: 'claude-3-5',
      });
    });

    it('inherits the leader model when the sub-agent has none configured', async () => {
      const { service } = createServiceWithEmployees({
        sub: { username: 'sub', modelSettings: { enabled: false, models: [] } },
        lead: {
          username: 'lead',
          modelSettings: {
            enabled: true,
            models: [{ llmService: 'openai', model: 'gpt-4o-mini' }],
          },
        },
      });

      await expect(service.resolveModelSettings('sub', 'lead')).resolves.toEqual({
        llmService: 'openai',
        model: 'gpt-4o-mini',
      });
    });

    it('prefers an explicit per-rule override over employee settings', async () => {
      const { service } = createServiceWithEmployees({
        sub: {
          username: 'sub',
          modelSettings: { enabled: true, models: [{ llmService: 'openai', model: 'gpt-4o' }] },
        },
      });

      await expect(
        service.resolveModelSettings('sub', undefined, { llmService: 'anthropic', model: 'claude-3-5' }),
      ).resolves.toEqual({ llmService: 'anthropic', model: 'claude-3-5' });
    });

    it('ignores dedicated models when not enabled and returns undefined with no fallback', async () => {
      const { service } = createServiceWithEmployees({
        sub: {
          username: 'sub',
          modelSettings: { enabled: false, models: [{ llmService: 'openai', model: 'gpt-4o' }] },
        },
      });

      await expect(service.resolveModelSettings('sub')).resolves.toBeUndefined();
    });
  });
});
