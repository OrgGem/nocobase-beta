/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import PluginWorkflowBuildGuideClient from '../index';

const runtimes = vi.hoisted(() => {
  class V1Instruction {}
  class V2Instruction {}
  return { V1Instruction, V2Instruction };
});

vi.mock('@nocobase/client', () => ({ Plugin: class Plugin {} }));
vi.mock('@nocobase/client-v2', () => ({
  useApp: () => ({ i18n: { t: (key: string) => key } }),
}));
vi.mock('@nocobase/plugin-workflow/client', () => ({ Instruction: runtimes.V1Instruction }));
vi.mock('@nocobase/plugin-workflow/client-v2', () => ({ Instruction: runtimes.V2Instruction }));
vi.mock('@ant-design/icons', () => ({
  FileTextOutlined: () => null,
  RobotOutlined: () => null,
  UploadOutlined: () => null,
}));
vi.mock('antd', () => ({
  Form: { Item: () => null },
  Select: () => null,
  Typography: { Paragraph: () => null },
}));

function strictWorkflow(instructionBase: new (...args: never[]) => object) {
  const entries = new Map<string, object>();
  const groups = new Map<string, { key: string; label: string }>();
  return {
    entries,
    groups,
    registerInstructionGroup: (key: string, group: { key: string; label: string }) => groups.set(key, group),
    registerInstruction: (type: string, instruction: object | (new (...args: never[]) => object)) => {
      const instance = typeof instruction === 'function' ? new instruction() : instruction;
      if (!(instance instanceof instructionBase)) throw new TypeError('invalid instruction type to register');
      entries.set(type, instance);
    },
  };
}

describe('legacy Workflow Build Guide client', () => {
  it('registers managed instructions with the legacy runtime base class', async () => {
    const workflow = strictWorkflow(runtimes.V1Instruction);
    const pluginContext = { app: { pm: { get: vi.fn(() => workflow) } } };

    await PluginWorkflowBuildGuideClient.prototype.load.call(
      pluginContext as unknown as PluginWorkflowBuildGuideClient,
    );

    expect(pluginContext.app.pm.get).toHaveBeenCalledWith('workflow');
    expect([...workflow.entries.keys()]).toEqual(['guide-build-prepare', 'guide-build-llm', 'guide-build-publish']);
    expect([...workflow.entries.values()].every((instruction) => instruction instanceof runtimes.V1Instruction)).toBe(
      true,
    );
    expect(workflow.groups.get('workflow-build-guide')).toEqual({
      key: 'workflow-build-guide',
      label: expect.stringContaining('Build Guide'),
    });
    expect(
      (workflow.entries.get('guide-build-llm') as { createDefaultConfig: () => unknown }).createDefaultConfig(),
    ).toEqual({ mode: 'plan' });
  });
});
