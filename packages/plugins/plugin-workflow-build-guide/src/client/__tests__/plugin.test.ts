/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import PluginWorkflowBuildGuideClient from '../index';

const mocks = vi.hoisted(() => ({ registerInstructions: vi.fn() }));

vi.mock('@nocobase/client', () => ({ Plugin: class Plugin {} }));
vi.mock('../../client-v2/instructions', () => ({ registerInstructions: mocks.registerInstructions }));

describe('legacy Workflow Build Guide client', () => {
  it('registers the managed guide instructions with the legacy workflow plugin', async () => {
    const workflow = { registerInstruction: vi.fn(), registerInstructionGroup: vi.fn() };
    const pluginContext = { app: { pm: { get: vi.fn(() => workflow) } } };

    await PluginWorkflowBuildGuideClient.prototype.load.call(
      pluginContext as unknown as PluginWorkflowBuildGuideClient,
    );

    expect(pluginContext.app.pm.get).toHaveBeenCalledWith('workflow');
    expect(mocks.registerInstructions).toHaveBeenCalledWith(workflow);
  });
});
