import { describe, expect, it, vi } from 'vitest';
import { SkillAccessService } from '../services/SkillAccessService';

function createService(employeeSettings: Record<string, unknown> | null) {
  const findOne = vi.fn(async ({ filter }: { filter: { username?: string; sessionId?: string } }) => {
    if (filter.username) {
      return employeeSettings
        ? {
            username: filter.username,
            skillSettings: employeeSettings,
          }
        : null;
    }
    return null;
  });
  const find = vi.fn(async () => []);
  const service = new SkillAccessService({
    db: {
      getRepository: vi.fn(() => ({ findOne, find })),
    },
  });
  return service;
}

const privateSkill = {
  name: 'generate-report',
  toolName: 'skill_hub_generate_report',
  toolScope: 'CUSTOM',
};

describe('SkillAccessService', () => {
  it('allows a skill-specific binding', async () => {
    const service = createService({
      tools: [{ name: 'skill_hub_generate_report', autoCall: false }],
    });

    await expect(service.canAgentUseSkill('reporter', privateSkill)).resolves.toBe(true);
  });

  it('does not treat the universal executor as permission for every skill', async () => {
    const service = createService({
      tools: [{ name: 'skill_hub_execute', autoCall: false }],
    });

    await expect(service.canAgentUseSkill('reporter', privateSkill)).resolves.toBe(false);
  });

  it('allows GENERAL skills without a per-agent binding', async () => {
    const service = createService({ tools: [] });
    await expect(service.canAgentUseSkill('reporter', { ...privateSkill, toolScope: 'GENERAL' })).resolves.toBe(true);
  });

  it('fails closed when execution has no AI employee context', async () => {
    const service = createService({ tools: [] });
    await expect(service.assertCanExecute({}, privateSkill)).rejects.toThrow('requires an AI employee context');
  });

  it('resolves the explicit aiEmployeeUsername action value', async () => {
    const service = createService({ tools: [] });
    await expect(
      service.resolveAgentUsername({ action: { params: { values: { aiEmployeeUsername: 'reporter' } } } }),
    ).resolves.toBe('reporter');
  });
});
