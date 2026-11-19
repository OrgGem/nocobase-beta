/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it, vi } from 'vitest';
import { createSkillExecuteTool } from '../tools/skill-execute';
import { SkillHubSubFeature } from '../skill-hub/plugin';

type Row = Record<string, unknown>;
type Runtime = { toolCallId: string; writer: ReturnType<typeof vi.fn> };

function skill(overrides: Row = {}) {
  const values: Row = {
    id: 1,
    name: 'monthly-report',
    toolName: 'skill_hub_monthly_report',
    title: 'Monthly report',
    description: 'Build a monthly report.',
    language: 'python',
    toolScope: 'CUSTOM',
    autoCall: true,
    interactionSchema: JSON.stringify({ type: 'confirm', prompt: 'Review the report.' }),
    inputSchema: { type: 'object', properties: {} },
    ...overrides,
  };
  return { get: (name: string) => values[name] };
}

function acceptedCall(overrides: Row = {}) {
  return {
    toolCallId: 'call-1',
    toolName: 'skill_hub_monthly_report',
    auto: false,
    invokeStatus: 'pending',
    userDecision: { type: 'approve' },
    ...overrides,
  };
}

function createFeature(options: { call?: Row | null } = {}) {
  const targetSkill = skill();
  const skillDefinitions = {
    find: vi.fn(async () => [targetSkill]),
    findOne: vi.fn(async () => targetSkill),
  };
  const skillLoopConfigs = {
    find: vi.fn(async () => []),
    findOne: vi.fn(async () => null),
  };
  const aiToolMessages = {
    findOne: vi.fn(async (query: Row) => {
      const filter = query.filter as Row;
      const call = options.call;
      if (!call || call.toolCallId !== filter.toolCallId || call.toolName !== filter.toolName) return null;
      return call;
    }),
  };
  const db = {
    getRepository(name: string) {
      if (name === 'skillDefinitions') return skillDefinitions;
      if (name === 'skillLoopConfigs') return skillLoopConfigs;
      if (name === 'aiToolMessages') return aiToolMessages;
      throw new Error(`Unexpected repository ${name}`);
    },
  };
  const toolsManager = {
    registerTools: vi.fn(),
    registerDynamicTools: vi.fn(),
  };
  const app = { aiManager: { toolsManager }, logger: { info: vi.fn(), warn: vi.fn() } };
  const feature = new SkillHubSubFeature({ app, db, name: 'plugin-agent-orchestrator' });
  const executeSkill = vi.spyOn(feature, 'executeSkill').mockResolvedValue({ status: 'succeeded', files: [] });
  vi.spyOn(feature, 'getSkillDescriptionForAI').mockResolvedValue('Monthly report instructions.');
  return { feature, app, toolsManager, skillDefinitions, skillLoopConfigs, aiToolMessages, executeSkill };
}

function runtime(toolCallId = 'call-1'): Runtime {
  return { toolCallId, writer: vi.fn() };
}

async function dynamicTool(feature: SkillHubSubFeature, app: { aiManager: { toolsManager: Row } }) {
  let registerDynamic: ((registration: { registerTools: (tools: unknown[]) => void }) => Promise<void>) | undefined;
  const toolsManager = app.aiManager.toolsManager as {
    registerTools: ReturnType<typeof vi.fn>;
    registerDynamicTools: ReturnType<typeof vi.fn>;
  };
  toolsManager.registerDynamicTools.mockImplementation((callback) => {
    registerDynamic = callback as typeof registerDynamic;
  });
  const methods = feature as unknown as { registerAITools(): void };
  methods.registerAITools();
  if (!registerDynamic) throw new Error('Dynamic skill tool registration did not run.');
  const tools: unknown[] = [];
  await registerDynamic({ registerTools: (registered) => tools.push(...registered) });
  const tool = tools.find((entry) => {
    const definition = (entry as { definition?: Row }).definition;
    return definition?.name === 'skill_hub_monthly_report';
  });
  if (!tool) throw new Error('Monthly report dynamic tool was not registered.');
  return tool as {
    defaultPermission: string;
    invoke(ctx: Row, args: Row, runtime?: Runtime): Promise<Row>;
  };
}

describe('Skill Hub explicit review guard', () => {
  it.each(['approve', 'edit'] as const)('allows a trusted native %s decision', async (decision) => {
    const call = acceptedCall({ userDecision: { type: decision } });
    const { feature, aiToolMessages } = createFeature({ call });

    await expect(
      feature.assertSkillReviewApproved(skill(), runtime(), 'skill_hub_monthly_report'),
    ).resolves.toBeUndefined();
    expect(aiToolMessages.findOne).toHaveBeenCalledWith({
      filter: { toolCallId: 'call-1', toolName: 'skill_hub_monthly_report' },
    });
  });

  it.each([
    ['Auto call is still enabled', acceptedCall({ auto: true }), runtime()],
    ['the call is not pending', acceptedCall({ invokeStatus: 'interrupted' }), runtime()],
    ['no native decision is recorded', acceptedCall({ userDecision: null }), runtime()],
    ['the native decision is reject', acceptedCall({ userDecision: { type: 'reject' } }), runtime()],
    ['the stored tool name does not match', acceptedCall({ toolName: 'skill_hub_other' }), runtime()],
    ['the tool-call identity does not match', acceptedCall(), runtime('other-call')],
    ['there is no trusted runtime tool-call identity', acceptedCall(), undefined],
  ])('fails closed when %s', async (_caseName, call, toolRuntime) => {
    const { feature, executeSkill } = createFeature({ call });

    await expect(feature.assertSkillReviewApproved(skill(), toolRuntime, 'skill_hub_monthly_report')).rejects.toThrow(
      'Human review is required',
    );
    expect(executeSkill).not.toHaveBeenCalled();
  });

  it('does not let the dynamic tool bypass review when Auto call is enabled', async () => {
    const { feature, app, executeSkill } = createFeature({ call: acceptedCall({ auto: true }) });
    const tool = await dynamicTool(feature, app);

    expect(tool.defaultPermission).toBe('ASK');
    await expect(tool.invoke({}, { input: {} }, runtime())).rejects.toThrow('Human review is required');
    expect(executeSkill).not.toHaveBeenCalled();
  });

  it.each(['approve', 'edit'] as const)('runs a dynamic tool only after native %s review', async (decision) => {
    const { feature, app, executeSkill } = createFeature({
      call: acceptedCall({ userDecision: { type: decision } }),
    });
    const tool = await dynamicTool(feature, app);

    const result = await tool.invoke({}, { input: {} }, runtime());

    expect(result.status).toBe('success');
    expect(executeSkill).toHaveBeenCalledOnce();
  });

  it('checks generic gateway execute actions before dispatching to the sandbox', async () => {
    const { feature, executeSkill } = createFeature({ call: acceptedCall({ auto: true }) });
    const tool = createSkillExecuteTool(feature);
    const result = await tool.invoke({}, { action: 'execute', skillName: 'monthly-report', input: {} }, runtime());

    expect(result.status).toBe('error');
    expect(result.content).toContain('Human review is required');
    expect(executeSkill).not.toHaveBeenCalled();
  });
});
