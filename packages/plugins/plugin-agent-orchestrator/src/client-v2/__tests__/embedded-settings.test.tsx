/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import * as ClientV2 from '@nocobase/client-v2';
import { AxiosHeaders } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginSettingEntry } from '../../../../plugin-block-embed-settings/src/client-v2/types';
import { collectEmbeddablePluginTabs } from '../../../../plugin-block-embed-settings/src/client-v2/EmbedSettingsPluginSelect';
import { EmbedSettingsBlock } from '../../../../plugin-block-embed-settings/src/client-v2/EmbedSettingsBlock';
import PluginAgentOrchestratorClient from '../plugin';

const tabKeys = [
  'ai-orchestrator.index',
  'ai-orchestrator.tracing',
  'ai-orchestrator.usage-governance',
  'ai-orchestrator.employee-governance',
  'ai-orchestrator.harness-profiles',
  'ai-orchestrator.approvals',
  'ai-orchestrator.agent-bindings',
  'ai-orchestrator.knowledge-access',
  'ai-orchestrator.retrieval-trace',
  'ai-orchestrator.memory-inspector',
  'ai-orchestrator.skill-definitions',
  'ai-orchestrator.skill-executions',
  'ai-orchestrator.skill-loop-settings',
  'ai-orchestrator.skill-metrics',
] as const;

const emptyCapabilityMatrix = {
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

function mockApiRequest(app: ReturnType<typeof ClientV2.createMockClient>) {
  return vi.spyOn(app.apiClient, 'request').mockImplementation(async (config) => {
    const url = 'url' in config ? config.url : undefined;
    return {
      data:
        url === 'agentHarnessProfiles:capabilities'
          ? { data: emptyCapabilityMatrix }
          : url === 'embedAllowedPlugins:list'
            ? { data: [{ id: 1, pluginName: 'ai-orchestrator', title: 'Agent Orchestrator', enabled: true }] }
            : { data: [], meta: { count: 0 } },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: { headers: new AxiosHeaders() },
    };
  });
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

vi.mock('@nocobase/flow-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nocobase/flow-engine')>();
  return {
    ...actual,
    useFlowContext: () => {
      throw new Error('Settings route context unavailable');
    },
  };
});

describe('Agent Orchestrator v2 embedded settings', () => {
  async function loadPlugin() {
    const app = ClientV2.createMockClient();
    await new PluginAgentOrchestratorClient({}, app).load();
    return app;
  }

  it('registers each settings page separately, including both governance pages', async () => {
    const app = await loadPlugin();
    const menu = app.pluginSettingsManager.get('ai-orchestrator', false);
    const children = menu?.children ?? [];

    expect(menu?.title).toBe('Agent Orchestrator');
    expect(children).toHaveLength(tabKeys.length);
    expect(new Set(children.map((child) => child.name))).toEqual(new Set(tabKeys));
    expect(new Set(collectTabs(app, 'ai-orchestrator').map((tab) => tab.value))).toEqual(new Set(tabKeys));
    expect(children.every((child) => typeof child.componentLoader === 'function')).toBe(true);
  });

  it.each(tabKeys)('renders %s as content-only when embedded and keeps standalone spacing', async (tabKey) => {
    const app = await loadPlugin();
    const request = mockApiRequest(app);
    vi.spyOn(ClientV2, 'useApp').mockReturnValue(app);

    const tab = collectTabs(app, 'ai-orchestrator').find((entry) => entry.value === tabKey);
    expect(tab?.componentLoader, tabKey).toBeTypeOf('function');
    if (!tab?.componentLoader) throw new Error(`Missing loader for ${tabKey}`);

    const module = await tab.componentLoader();
    const Page = (module as { default: React.ComponentType<{ embedded?: boolean }> }).default;

    const embeddedView = render(<Page embedded />);
    await waitFor(() => expect(request).toHaveBeenCalled());
    const embeddedContent = embeddedView.container.firstElementChild as HTMLElement | null;
    expect(embeddedContent, tabKey).not.toBeNull();
    expect(embeddedContent?.style.padding, tabKey).toBe('');
    expect(embeddedView.container.querySelector('.ant-tabs-nav'), tabKey).toBeNull();
    embeddedView.unmount();

    request.mockClear();
    const standaloneView = render(<Page />);
    await waitFor(() => expect(request).toHaveBeenCalled());
    const standaloneContent = standaloneView.container.firstElementChild as HTMLElement | null;
    expect(standaloneContent, tabKey).not.toBeNull();
    expect(standaloneContent?.style.padding, tabKey).toBe('0px 24px 24px');
    expect(standaloneView.container.querySelector('.ant-tabs-nav'), tabKey).toBeNull();
  });

  it('renders a selected child through the embed block without sibling settings tabs', async () => {
    const app = await loadPlugin();
    const request = mockApiRequest(app);
    vi.spyOn(ClientV2, 'useApp').mockReturnValue(app);

    const view = render(
      <EmbedSettingsBlock pluginName="ai-orchestrator" enabledTabKeys={['ai-orchestrator.employee-governance']} />,
    );

    expect(await screen.findByText('Governance policies')).toBeTruthy();
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(view.container.querySelector('.ant-tabs-nav')).toBeNull();
    expect(view.container.textContent).not.toContain('Native Monitor');
  });
});
