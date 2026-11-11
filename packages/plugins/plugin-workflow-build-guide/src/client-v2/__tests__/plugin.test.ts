/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import PluginWorkflowBuildGuideClientV2 from '../plugin';

const mocks = vi.hoisted(() => ({ registerInstructions: vi.fn() }));

vi.mock('@nocobase/client-v2', () => ({ Plugin: class Plugin {} }));
vi.mock('@nocobase/plugin-workflow/client-v2', () => ({ Instruction: class Instruction {} }));
vi.mock('../instructions', () => ({ registerInstructions: mocks.registerInstructions }));

describe('modern Workflow Build Guide client', () => {
  it('registers the managed guide instructions with the modern workflow plugin', async () => {
    const workflow = {
      registerInstruction: vi.fn(),
      registerInstructionGroup: vi.fn(),
      getInstruction: vi.fn(),
    };
    const pluginContext = { app: { pm: { get: vi.fn(() => workflow) } } };

    await PluginWorkflowBuildGuideClientV2.prototype.load.call(
      pluginContext as unknown as PluginWorkflowBuildGuideClientV2,
    );

    expect(pluginContext.app.pm.get).toHaveBeenCalledWith('workflow');
    expect(mocks.registerInstructions).toHaveBeenCalledWith(workflow);
  });
});
