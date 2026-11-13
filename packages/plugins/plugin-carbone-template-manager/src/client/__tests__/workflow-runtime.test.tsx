// SPDX-License-Identifier: Apache-2.0

import PluginCarboneTemplateManagerClient from '../plugin';
import PluginCarboneTemplateManagerClientV2 from '../../client-v2';

const runtime = vi.hoisted(() => ({
  InstructionV1: class V1Instruction {},
  InstructionV2: class V2Instruction {},
  WorkflowPluginV2: class WorkflowPluginV2 {},
}));

vi.mock('@nocobase/client', () => ({
  Plugin: class Plugin {},
  Variable: {},
  lazy: (_loader: unknown, name: string) => ({ [name]: () => null }),
}));
vi.mock('@nocobase/client-v2', () => ({ Plugin: class Plugin {} }));
vi.mock('@nocobase/flow-engine', () => ({ tExpr: (key: string) => key }));
vi.mock('@nocobase/plugin-workflow', () => ({ default: class WorkflowPlugin {} }));
vi.mock('@nocobase/plugin-workflow/client', () => ({ Instruction: runtime.InstructionV1 }));
vi.mock('@nocobase/plugin-workflow/client-v2', () => ({
  Instruction: runtime.InstructionV2,
  PluginWorkflowClientV2: runtime.WorkflowPluginV2,
}));
vi.mock('@ant-design/icons', () => ({ FilePdfOutlined: () => null }));
vi.mock('../workflow/TemplateSelect', () => ({ TemplateSelect: () => null }));

describe('Carbone Workflow instruction runtime registration', () => {
  it('registers a Carbone instruction instance from the v1 Workflow runtime', async () => {
    const entries = new Map<string, object>();
    const workflow = {
      registerInstruction: (type: string, instruction: object | (new () => object)) => {
        const instance = typeof instruction === 'function' ? new instruction() : instruction;
        if (!(instance instanceof runtime.InstructionV1)) throw new TypeError('invalid instruction type to register');
        entries.set(type, instance);
      },
    };
    const pluginContext = {
      app: {
        i18n: { language: 'en-US', addResourceBundle: vi.fn() },
        pm: { get: vi.fn(() => workflow) },
        pluginSettingsManager: { add: vi.fn() },
      },
    };

    await PluginCarboneTemplateManagerClient.prototype.load.call(
      pluginContext as unknown as PluginCarboneTemplateManagerClient,
    );

    expect(pluginContext.app.pm.get).toHaveBeenCalledWith('workflow');
    expect(entries.get('carbone-render')).toBeInstanceOf(runtime.InstructionV1);
    expect(pluginContext.app.pluginSettingsManager.add).toHaveBeenCalledTimes(3);
  });

  it('keeps the Carbone instruction on the v2 Workflow runtime', async () => {
    const entries = new Map<string, object>();
    const workflow = {
      registerInstruction: (type: string, instruction: object | (new () => object)) => {
        const instance = typeof instruction === 'function' ? new instruction() : instruction;
        if (!(instance instanceof runtime.InstructionV2)) throw new TypeError('invalid instruction type to register');
        entries.set(type, instance);
      },
    };
    const pluginContext = {
      app: { pm: { get: vi.fn(() => workflow) } },
      pluginSettingsManager: { addMenuItem: vi.fn(), addPageTabItem: vi.fn() },
      t: (key: string) => key,
    };

    await PluginCarboneTemplateManagerClientV2.prototype.load.call(
      pluginContext as unknown as PluginCarboneTemplateManagerClientV2,
    );

    expect(pluginContext.app.pm.get).toHaveBeenCalledWith(runtime.WorkflowPluginV2);
    expect(entries.get('carbone-render')).toBeInstanceOf(runtime.InstructionV2);
    expect(pluginContext.pluginSettingsManager.addPageTabItem).toHaveBeenCalledTimes(2);
  });
});
