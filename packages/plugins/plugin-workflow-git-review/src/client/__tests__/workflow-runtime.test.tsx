// SPDX-License-Identifier: Apache-2.0

import PluginWorkflowGitReviewClient from '../index';
import PluginWorkflowGitReviewClientV2 from '../../client-v2';

const runtimes = vi.hoisted(() => {
  class V1Instruction {}
  class V2Instruction {}
  return { V1Instruction, V2Instruction };
});

vi.mock('@nocobase/client', () => ({ Plugin: class Plugin {}, lazy: () => () => null }));
vi.mock('@nocobase/client-v2', () => ({
  Plugin: class Plugin {},
  useApp: () => ({ i18n: { t: (key: string) => key } }),
}));
vi.mock('@nocobase/plugin-workflow/client', () => ({ Instruction: runtimes.V1Instruction }));
vi.mock('@nocobase/plugin-workflow/client-v2', () => ({
  Instruction: runtimes.V2Instruction,
  WorkflowTypedVariableInput: () => null,
}));
vi.mock('@ant-design/icons', () => ({
  RobotOutlined: () => null,
  SafetyCertificateOutlined: () => null,
}));
vi.mock('antd', () => ({
  Form: { Item: () => null },
  Input: () => null,
  Typography: { Text: () => null },
}));
vi.mock('../../client-v2/Approvals', () => ({ reviewApprovalTaskType: {} }));

function strictWorkflow(instructionBase: new (...args: never[]) => object) {
  const entries = new Map<string, object>();
  const groups = new Map<string, { key: string; label: string }>();
  const workflow = {
    entries,
    groups,
    instructions: { get: (type: string) => entries.get(type) },
    registerInstructionGroup: (key: string, group: { key: string; label: string }) => groups.set(key, group),
    registerInstruction: (type: string, instruction: object | (new (...args: never[]) => object)) => {
      const instance = typeof instruction === 'function' ? new instruction() : instruction;
      if (!(instance instanceof instructionBase)) throw new TypeError('invalid instruction type to register');
      entries.set(type, instance);
    },
    getInstruction: (type: string) => entries.get(type),
    registerTaskType: vi.fn(),
  };
  return workflow;
}

function pluginContext(workflow: ReturnType<typeof strictWorkflow>) {
  return {
    app: {
      pm: { get: vi.fn(() => workflow) },
      pluginSettingsManager: { add: vi.fn(), addMenuItem: vi.fn(), addPageTabItem: vi.fn() },
    },
    t: (key: string) => key,
    pluginSettingsManager: { add: vi.fn(), addMenuItem: vi.fn(), addPageTabItem: vi.fn() },
  };
}

describe('Git Review workflow instruction runtime registration', () => {
  it('registers v1 instructions as v1 instances and keeps the native LLM fieldset', async () => {
    const workflow = strictWorkflow(runtimes.V1Instruction);
    const nativeLLM = new runtimes.V1Instruction() as InstanceType<typeof runtimes.V1Instruction> & {
      FieldsetLoader: () => Promise<{ default: () => null }>;
    };
    const nativeFieldset = async () => ({ default: () => null });
    nativeLLM.FieldsetLoader = nativeFieldset;
    workflow.entries.set('llm', nativeLLM);
    const context = pluginContext(workflow);

    await PluginWorkflowGitReviewClient.prototype.load.call(context as unknown as PluginWorkflowGitReviewClient);

    expect([...workflow.entries.keys()].filter((type) => type.startsWith('git-review-'))).toEqual([
      'git-review-llm',
      'git-review-context',
      'git-review-result',
      'git-review-publish',
    ]);
    for (const type of ['git-review-llm', 'git-review-context', 'git-review-result', 'git-review-publish']) {
      expect(workflow.entries.get(type)).toBeInstanceOf(runtimes.V1Instruction);
    }
    expect((workflow.entries.get('git-review-llm') as typeof nativeLLM).FieldsetLoader).toBe(nativeFieldset);
    expect(workflow.groups.get('git-review')).toEqual({
      key: 'git-review',
      label: expect.stringContaining('Git review'),
    });
  });

  it('keeps v2 instructions and manual approval on the v2 base class', async () => {
    const workflow = strictWorkflow(runtimes.V2Instruction);
    const nativeLLM = new runtimes.V2Instruction() as InstanceType<typeof runtimes.V2Instruction> & {
      FieldsetLoader: () => Promise<{ default: () => null }>;
    };
    const nativeFieldset = async () => ({ default: () => null });
    nativeLLM.FieldsetLoader = nativeFieldset;
    workflow.entries.set('llm', nativeLLM);
    const context = pluginContext(workflow);

    await PluginWorkflowGitReviewClientV2.prototype.load.call(context as unknown as PluginWorkflowGitReviewClientV2);

    for (const type of ['git-review-llm', 'git-review-context', 'git-review-result', 'git-review-publish', 'manual']) {
      expect(workflow.entries.get(type)).toBeInstanceOf(runtimes.V2Instruction);
    }
    expect((workflow.entries.get('git-review-llm') as typeof nativeLLM).FieldsetLoader).toBe(nativeFieldset);
    expect(workflow.registerTaskType).toHaveBeenCalledWith('git-review-approval', expect.any(Object));
  });
});
