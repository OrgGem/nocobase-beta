import { describe, expect, it, vi } from 'vitest';
import { createSkillExecuteTool } from '../tools/skill-execute';

describe('createSkillExecuteTool', () => {
  it('bridges ToolsRuntime onto ctx.runtime while executing a skill', async () => {
    const runtime = { toolCallId: 'tool-1', writer: vi.fn() };
    const ctx: { runtime?: typeof runtime } = {};
    const skill = { get: vi.fn((name: string) => (name === 'name' ? 'demo' : undefined)) };
    const executeSkill = vi.fn(async (_skill, _input, executeCtx) => {
      expect(executeCtx.runtime).toBe(runtime);
      return {
        status: 'succeeded',
        files: [],
      };
    });
    const plugin = {
      app: { logger: { info: vi.fn() } },
      db: {
        getRepository: vi.fn(() => ({
          findOne: vi.fn(async () => skill),
        })),
      },
      executeSkill,
    };

    const tool = createSkillExecuteTool(plugin);
    const result = await tool.invoke(ctx, { action: 'execute', skillName: 'demo', input: { ok: true } }, runtime);

    expect(result.status).toBe('success');
    expect(executeSkill).toHaveBeenCalledOnce();
    expect(ctx.runtime).toBeUndefined();
  });

  it('lists only skills authorized for the current AI employee', async () => {
    const makeSkill = (name: string) => ({
      get: vi.fn((field: string) => {
        const values: Record<string, unknown> = {
          name,
          toolName: `skill_hub_${name}`,
          title: name,
          description: `${name} description`,
          language: 'python',
          toolScope: 'CUSTOM',
          storageType: 'database',
        };
        return values[field];
      }),
    });
    const allowed = makeSkill('allowed');
    const denied = makeSkill('denied');
    const plugin = {
      app: { logger: { info: vi.fn() } },
      db: {
        getRepository: vi.fn(() => ({
          find: vi.fn(async () => [allowed, denied]),
        })),
      },
      skillAccessService: {
        filterAccessibleSkills: vi.fn(async (_ctx, skills) => skills.filter((skill) => skill === allowed)),
      },
    };

    const tool = createSkillExecuteTool(plugin);
    const result = await tool.invoke({}, { action: 'list' });
    const content = JSON.parse(result.content);

    expect(content.skills).toHaveLength(1);
    expect(content.skills[0]).toMatchObject({ name: 'allowed', toolName: 'skill_hub_allowed' });
  });
});
