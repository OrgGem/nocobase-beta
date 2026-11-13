/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import {
  GuideBuildLLMInstruction,
  GuideBuildPrepareInstruction,
  GuideBuildPublishInstruction,
  registerInstructions,
} from '../instructions';

vi.mock('@nocobase/client-v2', () => ({ useApp: () => ({ i18n: { t: (key: string) => key } }) }));
const runtime = vi.hoisted(() => ({ Instruction: class V2Instruction {} }));

vi.mock('@nocobase/plugin-workflow/client-v2', () => ({ Instruction: runtime.Instruction }));
vi.mock('@ant-design/icons', () => ({
  FileTextOutlined: () => null,
  RobotOutlined: () => null,
  UploadOutlined: () => null,
}));

describe('Workflow Build Guide instruction registration', () => {
  it('registers the three managed instruction types with restricted graph editing', () => {
    const groups = new Map<string, { key: string; label: string }>();
    const instructions = new Map<string, object>();
    registerInstructions({
      registerInstructionGroup: (key, value) => groups.set(key, value),
      registerInstruction: (type, instruction) => {
        const instance = typeof instruction === 'function' ? new instruction() : instruction;
        if (!(instance instanceof runtime.Instruction)) throw new TypeError('invalid instruction type to register');
        instructions.set(type, instance);
      },
    });

    expect(groups.get('workflow-build-guide')).toEqual({
      key: 'workflow-build-guide',
      label: expect.stringContaining('Build Guide'),
    });
    expect(instructions.get('guide-build-prepare')).toBeInstanceOf(runtime.Instruction);
    expect(instructions.get('guide-build-llm')).toBeInstanceOf(runtime.Instruction);
    expect(instructions.get('guide-build-publish')).toBeInstanceOf(runtime.Instruction);

    const llm = new GuideBuildLLMInstruction();
    expect(llm.createDefaultConfig()).toEqual({ mode: 'plan' });
    expect(new GuideBuildPrepareInstruction().isAvailable()).toBe(false);
    expect(llm.isAvailable()).toBe(false);
    expect(new GuideBuildPublishInstruction().isAvailable()).toBe(false);
  });
});
