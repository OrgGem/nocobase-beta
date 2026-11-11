/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { Suspense } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { Application } from '@nocobase/client';
import * as ClientV2 from '@nocobase/client-v2';
import { AxiosHeaders } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginSettingEntry } from '../../../../plugin-block-embed-settings/src/client/types';
import { EmbedSettingsBlock } from '../../../../plugin-block-embed-settings/src/client/EmbedSettingsBlock';
import { collectEmbeddablePluginTabs } from '../../../../plugin-block-embed-settings/src/client/EmbedSettingsPluginSelect';
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
  children?: SettingsEntrySource[];
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

function collectTabs(app: Application, pluginName: string) {
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

vi.mock('@formily/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@formily/react')>();
  return {
    ...actual,
    useFieldSchema: () => undefined,
  };
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

describe('Agent Orchestrator v1 embedded settings', () => {
  async function loadPlugin() {
    const legacyApp = new Application({});
    await new PluginAgentOrchestratorClient({}, legacyApp).load();
    return legacyApp;
  }

  async function prepareEmbeddedApp(legacyApp: Application) {
    const apiApp = ClientV2.createMockClient();
    const app = Object.assign({}, apiApp, {
      pluginSettingsManager: legacyApp.pluginSettingsManager,
    }) as typeof apiApp;
    const request = vi.spyOn(apiApp.apiClient, 'request').mockImplementation(async (config) => {
      const url = 'url' in config ? config.url : undefined;
      return {
        data:
          url === 'agentHarnessProfiles:capabilities'
            ? { data: emptyCapabilityMatrix }
            : { data: [], meta: { count: 0 } },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: { headers: new AxiosHeaders() },
      };
    });
    vi.spyOn(ClientV2, 'useApp').mockReturnValue(app);
    return { app, request };
  }

  it('registers the same 14 child pages and keeps the saved v1 ACL snippet', async () => {
    const app = await loadPlugin();
    app.pluginSettingsManager.setAclSnippets([]);

    const menu = app.pluginSettingsManager.get('ai-orchestrator');
    const children = menu?.children ?? [];
    expect(menu?.title).toBe('Agent Orchestrator');
    expect(menu?.aclSnippet).toBe('pm.ai-orchestrator');
    expect(children).toHaveLength(tabKeys.length);
    expect(new Set(children.map((child) => child.name))).toEqual(new Set(tabKeys));
    expect(children.every((child) => child.aclSnippet === 'pm.ai-orchestrator')).toBe(true);
    expect(new Set(collectTabs(app, 'ai-orchestrator').map((tab) => tab.value))).toEqual(new Set(tabKeys));

    app.pluginSettingsManager.setAclSnippets(['!pm.ai-orchestrator']);
    expect(app.pluginSettingsManager.getList().map((item) => item.name)).not.toContain('ai-orchestrator');
    expect(collectTabs(app, 'ai-orchestrator')).toEqual([]);
  });

  it.each(tabKeys)('renders %s as content-only when embedded and keeps standalone spacing', async (tabKey) => {
    const legacyApp = await loadPlugin();
    legacyApp.pluginSettingsManager.setAclSnippets([]);
    const { request } = await prepareEmbeddedApp(legacyApp);
    const tab = collectTabs(legacyApp, 'ai-orchestrator').find((entry) => entry.value === tabKey);
    expect(tab?.Component, tabKey).toBeDefined();
    if (!tab?.Component) throw new Error(`Missing component for ${tabKey}`);
    const Page = tab.Component as React.ComponentType<{ embedded?: boolean }>;

    const embeddedView = render(
      <Suspense fallback={null}>
        <Page embedded />
      </Suspense>,
    );
    await waitFor(() => expect(request).toHaveBeenCalled());
    const embeddedContent = embeddedView.container.firstElementChild as HTMLElement | null;
    expect(embeddedContent, tabKey).not.toBeNull();
    expect(embeddedContent?.style.padding, tabKey).toBe('');
    expect(embeddedView.container.querySelector('.ant-tabs-nav'), tabKey).toBeNull();
    embeddedView.unmount();

    request.mockClear();
    const standaloneView = render(
      <Suspense fallback={null}>
        <Page />
      </Suspense>,
    );
    await waitFor(() => expect(request).toHaveBeenCalled());
    const standaloneContent = standaloneView.container.firstElementChild as HTMLElement | null;
    expect(standaloneContent, tabKey).not.toBeNull();
    expect(standaloneContent?.style.padding, tabKey).toBe('0px 24px 24px');
    expect(standaloneView.container.querySelector('.ant-tabs-nav'), tabKey).toBeNull();
  });

  it.each([
    ['ai-orchestrator.usage-governance', 'Usage filters'],
    ['ai-orchestrator.employee-governance', 'Governance policies'],
  ])('renders only the selected child page %s without settings-route context', async (selectedKey, bodyLabel) => {
    const legacyApp = await loadPlugin();
    legacyApp.pluginSettingsManager.setAclSnippets([]);
    const { request } = await prepareEmbeddedApp(legacyApp);

    const view = render(<EmbedSettingsBlock pluginName="ai-orchestrator" enabledTabKeys={[selectedKey]} />);
    await waitFor(() => expect(request).toHaveBeenCalled());

    expect(await screen.findByText(bodyLabel)).toBeTruthy();
    expect(view.container.querySelector('.ant-tabs-nav')).toBeNull();
    expect(view.container.textContent).not.toContain('Native Monitor');
  });

  it('recovers all child pages for a saved v1 root key without nesting the old settings tabs', async () => {
    const legacyApp = await loadPlugin();
    legacyApp.pluginSettingsManager.setAclSnippets([]);
    const { request } = await prepareEmbeddedApp(legacyApp);

    const view = render(<EmbedSettingsBlock pluginName="ai-orchestrator" enabledTabKeys={['ai-orchestrator']} />);
    await waitFor(() => expect(request).toHaveBeenCalled());
    await waitFor(() => expect(view.container.querySelectorAll('.ant-tabs-nav')).toHaveLength(1));

    expect(view.container.querySelectorAll('.ant-tabs-tab')).toHaveLength(tabKeys.length);
    expect(view.container.textContent).toContain('Native Monitor');
    expect(view.container.querySelectorAll('.ant-tabs-nav')).toHaveLength(1);
  });
});
