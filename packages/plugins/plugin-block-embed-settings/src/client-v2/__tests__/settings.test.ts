// SPDX-License-Identifier: Apache-2.0

import { createMockClient } from '@nocobase/client-v2';
import { describe, expect, it, vi } from 'vitest';
import { collectEmbeddablePluginTabs } from '../EmbedSettingsPluginSelect';
import { EmbedSettingsBlockModel } from '../models/EmbedSettingsBlockModel';
import Plugin from '../plugin';

describe('Embed settings with native V2 registry', () => {
  it('excludes hidden/dynamic and denied tabs using the native settings snapshot', () => {
    const app = createMockClient();
    const manager = app.pluginSettingsManager;
    manager.addMenuItem({ key: 'demo', title: 'Demo' });
    manager.addPageTabItem({
      menuKey: 'demo',
      key: 'index',
      title: 'Index',
      componentLoader: async () => ({ default: () => null }),
    });
    manager.addPageTabItem({
      menuKey: 'demo',
      key: ':name',
      title: false,
      hidden: true,
      componentLoader: async () => ({ default: () => null }),
    });
    manager.setAclSnippets(['!pm.demo.:name']);
    expect(collectEmbeddablePluginTabs(app, 'demo').map((tab) => tab.value)).toEqual(['demo.index']);
    manager.setAclSnippets(['!pm.demo.index']);
    expect(collectEmbeddablePluginTabs(app, 'demo')).toEqual([]);
  });

  it('retains an ACL-granted child tab without requiring a parent-menu grant', () => {
    const app = createMockClient();
    const manager = app.pluginSettingsManager;
    manager.addMenuItem({ key: 'demo', title: 'Demo' });
    manager.addPageTabItem({
      menuKey: 'demo',
      key: 'index',
      title: 'Index',
      componentLoader: async () => ({ default: () => null }),
    });
    manager.addPageTabItem({
      menuKey: 'demo',
      key: 'restricted',
      title: 'Restricted',
      componentLoader: async () => ({ default: () => null }),
    });
    manager.setAclSnippets(['!pm.demo', 'pm.demo.index', '!pm.demo.restricted']);

    expect(collectEmbeddablePluginTabs(app, 'demo').map((tab) => tab.value)).toEqual(['demo.index']);
  });

  it('uses the server plugin name for settings ACL entries and links Plugin Manager settings', async () => {
    const app = createMockClient();
    await new Plugin({}, app).load();
    const menu = app.pluginSettingsManager.get('block-embed-settings');
    expect(menu.aclSnippet).toBe('pm.plugin-block-embed-settings');
    expect(menu.children[0].aclSnippet).toBe('pm.plugin-block-embed-settings');
    expect(app.pluginSettingsManager.hasPluginSettings('plugin-block-embed-settings')).toBe(true);
  });

  it('translates flow labels with plugin namespace and gates collectionPath by requiresCollection', async () => {
    const app = createMockClient();
    app.pluginSettingsManager.addMenuItem({ key: 'plain', title: 'Plain' });
    app.pluginSettingsManager.addPageTabItem({
      menuKey: 'plain',
      key: 'index',
      title: 'Plain',
      Component: () => null,
    });
    app.pluginSettingsManager.addMenuItem({
      key: 'needs-collection',
      title: 'Needs Collection',
      embedSettings: { requiresCollection: true },
    });
    app.pluginSettingsManager.addPageTabItem({
      menuKey: 'needs-collection',
      key: 'index',
      title: 'Needs Collection',
      Component: () => null,
    });

    const modelClass = EmbedSettingsBlockModel as typeof EmbedSettingsBlockModel & {
      globalFlowRegistry: {
        getFlow: (key: string) => {
          steps: {
            selectPlugin: {
              uiSchema: (ctx: unknown) => {
                pluginName: { title: string };
                enabledTabKeys: { title: string };
                collectionPath: {
                  title: string;
                  'x-reactions': (field: {
                    form: { values?: { pluginName?: string } };
                    hidden?: boolean;
                    required?: boolean;
                    value?: unknown;
                    setValue: (val: unknown) => void;
                  }) => void;
                };
              };
              handler: (ctx: unknown, params: Record<string, unknown>) => Promise<void>;
            };
          };
        };
      };
    };
    const step = modelClass.globalFlowRegistry.getFlow('embedSettingsBlockSettings').steps.selectPlugin;
    const tSpy = vi.fn((key: string) => key);
    const setProps = vi.fn();
    const ctx = { app, t: tSpy, model: { props: {}, setProps } };

    const schema = step.uiSchema(ctx);
    expect(tSpy).toHaveBeenCalledWith('Select plugin', {
      ns: ['plugin-block-embed-settings', 'client'],
      nsMode: 'fallback',
    });
    expect(tSpy).toHaveBeenCalledWith('Enabled tabs', {
      ns: ['plugin-block-embed-settings', 'client'],
      nsMode: 'fallback',
    });

    const setValue = vi.fn();
    const plainField = { form: { values: { pluginName: 'plain' } }, value: 'main::orders', setValue };
    schema.collectionPath['x-reactions'](plainField);
    expect(plainField).toMatchObject({ hidden: true, required: false });
    expect(setValue).toHaveBeenCalledWith(undefined);

    const collectionField = { form: { values: { pluginName: 'needs-collection' } }, setValue: vi.fn() };
    schema.collectionPath['x-reactions'](collectionField);
    expect(collectionField).toMatchObject({ hidden: false, required: true });

    await step.handler(ctx, { pluginName: 'plain', enabledTabKeys: ['plain.index'] });
    expect(setProps).toHaveBeenLastCalledWith({
      pluginName: 'plain',
      enabledTabKeys: ['plain.index'],
      dataSourceName: undefined,
      collectionName: undefined,
    });

    await step.handler(ctx, {
      pluginName: 'needs-collection',
      enabledTabKeys: ['needs-collection.index'],
      collectionPath: 'custom-ds::orders',
    });
    expect(setProps).toHaveBeenLastCalledWith({
      pluginName: 'needs-collection',
      enabledTabKeys: ['needs-collection.index'],
      dataSourceName: 'custom-ds',
      collectionName: 'orders',
    });
  });
});
