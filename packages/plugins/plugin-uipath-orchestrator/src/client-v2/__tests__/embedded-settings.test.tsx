// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import * as ClientV2 from '@nocobase/client-v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosHeaders } from 'axios';
import type { PluginSettingEntry } from '../../../../plugin-block-embed-settings/src/client-v2/types';
import { collectEmbeddablePluginTabs } from '../../../../plugin-block-embed-settings/src/client-v2/EmbedSettingsPluginSelect';
import AgentPlugin from '../../../../plugin-agent-orchestrator/src/client-v2/plugin';
import KnowledgePlugin from '../../../../plugin-knowledge-base/src/client-v2/plugin';
import UiPathPlugin from '../plugin';
import knowledgeVietnamese from '../../../../plugin-knowledge-base/src/locale/vi-VN.json';
import knowledgeChinese from '../../../../plugin-knowledge-base/src/locale/zh-CN.json';

const cases = [
  ['UiPath', UiPathPlugin, 'uipath-orchestrator', 'pm.plugin-uipath-orchestrator', 1],
  ['Agent', AgentPlugin, 'ai-orchestrator', 'pm.plugin-agent-orchestrator', 14],
  ['Knowledge Base', KnowledgePlugin, 'ai-knowledge-base', 'pm.plugin-knowledge-base.knowledge-base', 3],
] as const;

const emptyHarnessCapabilityMatrix = {
  noteKey: 'No harness capabilities reported',
  scopes: [],
  nativeCapabilities: [],
  scopedCapabilities: [],
  telemetrySettings: { noteKey: 'Telemetry settings are plugin-local', settings: [] },
};

type SettingsEntrySource = {
  name?: string;
  key?: string;
  title?: React.ReactNode;
  label?: React.ReactNode;
  Component?: unknown;
  componentLoader?: unknown;
  children?: readonly SettingsEntrySource[];
};

function normalizeSetting(entry: SettingsEntrySource, fallbackName: string): PluginSettingEntry {
  return {
    name: entry.name ?? fallbackName,
    key: entry.key,
    title: entry.title,
    label: entry.label,
    Component: entry.Component as PluginSettingEntry['Component'],
    componentLoader: entry.componentLoader as PluginSettingEntry['componentLoader'],
    children: entry.children?.map((child) =>
      normalizeSetting(child, child.name ?? `${fallbackName}.${child.key ?? 'child'}`),
    ),
  };
}

function collectTabs(app: ReturnType<typeof ClientV2.createMockClient>, pluginName: string) {
  return collectEmbeddablePluginTabs(
    {
      pluginSettingsManager: {
        has: (name) => app.pluginSettingsManager.has(name),
        get: (name) => {
          const setting = app.pluginSettingsManager.get(name);
          return setting ? normalizeSetting(setting, name) : undefined;
        },
      },
      i18n: app.i18n,
    },
    pluginName,
  );
}

beforeEach(() => {
  vi.spyOn(window, 'matchMedia').mockImplementation((media) => ({
    matches: false,
    media,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe.each(cases)('%s embedded settings', (_label, Plugin, menuKey, snippet, tabCount) => {
  async function loadPlugin() {
    const app = ClientV2.createMockClient();
    await new Plugin({}, app).load();
    return app;
  }

  it('uses the server permission for the menu and every embeddable tab', async () => {
    const app = await loadPlugin();
    expect(new Set(app.pluginSettingsManager.getAclSnippets())).toEqual(new Set([snippet]));
    expect(collectTabs(app, menuKey)).toHaveLength(tabCount);
  });

  it('hides all embedded pages when the server permission is denied', async () => {
    const app = await loadPlugin();
    app.pluginSettingsManager.setAclSnippets([`!${snippet}`]);
    expect(collectTabs(app, menuKey)).toEqual([]);
    expect(app.pluginSettingsManager.get(menuKey)).toBeNull();
  });

  it('keeps pages visible when unrelated default snippets are denied', async () => {
    const app = await loadPlugin();
    const menu = app.pluginSettingsManager.get(menuKey, false);
    app.pluginSettingsManager.setAclSnippets([
      `!pm.${menuKey}`,
      ...(menu?.children ?? []).map((page) => `!pm.${page.name}`),
    ]);
    expect(collectTabs(app, menuKey)).toHaveLength(tabCount);
  });

  it('loads and renders every tab with only the application available', async () => {
    const app = await loadPlugin();
    vi.spyOn(ClientV2, 'useApp').mockReturnValue(app);
    const request = vi.spyOn(app.apiClient, 'request').mockImplementation(async (config) => {
      const url = 'url' in config ? config.url : undefined;
      return {
        data: url === 'agentHarnessProfiles:capabilities' ? { data: emptyHarnessCapabilityMatrix } : { data: [] },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: { headers: new AxiosHeaders() },
      };
    });
    for (const tab of collectTabs(app, menuKey)) {
      const loader = tab.componentLoader;
      expect(loader).toBeTypeOf('function');
      if (!loader) throw new Error('Missing settings page loader');
      const module = await loader();
      const Page = (module as { default: React.ComponentType<{ embedded?: boolean }> }).default;
      const view = render(<Page embedded />);
      await waitFor(() => expect(request).toHaveBeenCalled());
      expect(view.container.childElementCount, tab.value).toBeGreaterThan(0);
      view.unmount();
      request.mockClear();
    }
  });
});

it('loads the repaired Knowledge Base locales', () => {
  const key = 'Only administrators can configure External RAG providers that forward LLM credentials.';
  expect(knowledgeVietnamese[key]).toBeTypeOf('string');
  expect(knowledgeChinese[key]).toBeTypeOf('string');
  expect(knowledgeVietnamese.Retrying).toBe('Đang thử lại');
  expect(knowledgeChinese.Retrying).toBe('重试中');
});
