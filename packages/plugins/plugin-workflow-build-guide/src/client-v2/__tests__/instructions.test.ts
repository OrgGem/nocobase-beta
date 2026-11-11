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
vi.mock('@nocobase/plugin-workflow/client-v2', () => ({ Instruction: class Instruction {} }));
vi.mock('@ant-design/icons', () => ({
  FileTextOutlined: () => null,
  RobotOutlined: () => null,
  UploadOutlined: () => null,
}));

describe('Workflow Build Guide instruction registration', () => {
  it('registers the three managed instruction types with restricted graph editing', () => {
    const groups = new Map<string, { key: string; label: string }>();
    const instructions = new Map<string, unknown>();
    registerInstructions({
      registerInstructionGroup: (key, value) => groups.set(key, value),
      registerInstruction: (type, instruction) => instructions.set(type, instruction),
    });

    expect(groups.get('workflow-build-guide')).toEqual({
      key: 'workflow-build-guide',
      label: expect.stringContaining('Build Guide'),
    });
    expect(instructions.get('guide-build-prepare')).toBe(GuideBuildPrepareInstruction);
    expect(instructions.get('guide-build-llm')).toBe(GuideBuildLLMInstruction);
    expect(instructions.get('guide-build-publish')).toBe(GuideBuildPublishInstruction);

    const llm = new GuideBuildLLMInstruction();
    expect(llm.createDefaultConfig()).toEqual({ mode: 'plan' });
    expect(new GuideBuildPrepareInstruction().isAvailable()).toBe(false);
    expect(llm.isAvailable()).toBe(false);
    expect(new GuideBuildPublishInstruction().isAvailable()).toBe(false);
  });
});
