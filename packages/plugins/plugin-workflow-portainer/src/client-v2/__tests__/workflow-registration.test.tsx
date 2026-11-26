/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import PluginWorkflowPortainerClient from '../../client';
import PluginWorkflowPortainerClientV2 from '../index';
import { INSTRUCTION_GROUP_KEY, INSTRUCTION_TYPES } from '../../shared/constants';

const runtimes = vi.hoisted(() => {
  class V1Instruction {}
  class V2Instruction {}
  const ExtendCollectionsProvider = () => null;
  return { V1Instruction, V2Instruction, ExtendCollectionsProvider };
});

vi.mock('@nocobase/client', () => ({ Plugin: class Plugin {} }));
vi.mock('@nocobase/client-v2', () => ({
  Plugin: class Plugin {},
  ExtendCollectionsProvider: runtimes.ExtendCollectionsProvider,
  useApp: () => ({ i18n: { t: (key: string) => key } }),
}));
vi.mock('@nocobase/plugin-workflow/client', () => ({
  Instruction: runtimes.V1Instruction,
}));
vi.mock('@nocobase/plugin-workflow/client-v2', () => ({
  Instruction: runtimes.V2Instruction,
  defaultFieldNames: { value: 'value', label: 'label', children: 'children' },
}));
vi.mock('@ant-design/icons', () => ({
  CloudUploadOutlined: () => null,
  ClusterOutlined: () => null,
}));

function createStrictWorkflow(baseClass: new (...args: never[]) => object) {
  const instructions = new Map<string, Record<string, unknown>>();
  const groups = new Map<string, { key: string; label: string }>();

  return {
    instructions,
    groups,
    registerInstructionGroup(key: string, group: { key: string; label: string }) {
      groups.set(key, group);
    },
    registerInstruction(type: string, ctorOrInstance: object | (new () => object)) {
      const instance = typeof ctorOrInstance === 'function' ? new ctorOrInstance() : ctorOrInstance;
      if (!(instance instanceof baseClass)) {
        throw new TypeError(`Instruction ${type} does not match runtime Instruction base class`);
      }
      instructions.set(type, instance as Record<string, unknown>);
    },
  };
}

describe('Portainer workflow dual-runtime client registration', () => {
  it('registers v1 instructions extending @nocobase/plugin-workflow/client Instruction and collection reload hook', async () => {
    const workflow = createStrictWorkflow(runtimes.V1Instruction);
    const collections = new Map<string, object>();
    const reloadCallbacks: Array<() => void> = [];
    const dataSource = {
      collectionManager: {
        getCollection: (name: string) => collections.get(name),
        addCollections: (items: Array<{ name: string }>) => {
          for (const item of items) collections.set(item.name, item);
        },
      },
      addReloadCallback: (cb: () => void) => reloadCallbacks.push(cb),
    };

    const pluginCtx = {
      app: {
        pm: { get: vi.fn(() => workflow) },
        dataSourceManager: { getDataSource: vi.fn(() => dataSource) },
        pluginSettingsManager: { add: vi.fn() },
      },
      t: (key: string) => key,
    };

    await PluginWorkflowPortainerClient.prototype.load.call(pluginCtx as unknown as PluginWorkflowPortainerClient);

    expect(collections.has('portainerInstances')).toBe(true);
    collections.delete('portainerInstances');
    reloadCallbacks[0]();
    expect(collections.has('portainerInstances')).toBe(true);

    expect(workflow.groups.has(INSTRUCTION_GROUP_KEY)).toBe(true);
    expect(workflow.instructions.has(INSTRUCTION_TYPES.redeploy)).toBe(true);
    expect(workflow.instructions.has(INSTRUCTION_TYPES.control)).toBe(true);

    const redeployInst = workflow.instructions.get(INSTRUCTION_TYPES.redeploy) as {
      useVariables: (node: { key: string; title: string }) => { children: Array<{ value: string }> };
    };
    const vars = redeployInst.useVariables({ key: 'build_node', title: 'Build Stack' });
    const childKeys = vars.children.map((item) => item.value);
    expect(childKeys).toContain('stackId');
    expect(childKeys).toContain('endpointId');
    expect(childKeys).toContain('healthy');
    expect(childKeys).toContain('appliedEnv');
  });

  it('registers v2 instructions extending @nocobase/plugin-workflow/client-v2 Instruction and settings page', async () => {
    const workflow = createStrictWorkflow(runtimes.V2Instruction);
    const addMenuItem = vi.fn();
    const addPageTabItem = vi.fn();

    const pluginCtx = {
      app: {
        pm: { get: vi.fn(() => workflow) },
        addProvider: vi.fn(),
      },
      pluginSettingsManager: {
        addMenuItem,
        addPageTabItem,
      },
      t: (key: string) => key,
    };

    await PluginWorkflowPortainerClientV2.prototype.load.call(pluginCtx as unknown as PluginWorkflowPortainerClientV2);

    expect(pluginCtx.app.addProvider).toHaveBeenCalledWith(runtimes.ExtendCollectionsProvider, {
      collections: [expect.objectContaining({ name: 'portainerInstances' })],
    });
    expect(workflow.instructions.get(INSTRUCTION_TYPES.redeploy)).toBeInstanceOf(runtimes.V2Instruction);
    expect(workflow.instructions.get(INSTRUCTION_TYPES.control)).toBeInstanceOf(runtimes.V2Instruction);
    expect(addMenuItem).toHaveBeenCalledTimes(1);
    expect(addPageTabItem).toHaveBeenCalledTimes(1);
  });
});
