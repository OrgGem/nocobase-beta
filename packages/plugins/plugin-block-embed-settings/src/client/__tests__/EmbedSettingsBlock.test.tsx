// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { EmbedSettingsBlock } from '../EmbedSettingsBlock';

const allowlist = vi.hoisted(() => ({ records: [] as Array<{ pluginName: string; title: string }> }));

// Mock dependencies
vi.mock('@formily/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@formily/react')>()),
  useFieldSchema: () => ({ 'x-component-props': {} }),
}));

vi.mock('@nocobase/client-v2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nocobase/client-v2')>()),
  useApp: () => ({
    pluginSettingsManager: {
      getList: () => [
        { name: 'demo', title: 'Demo' },
        { name: 'multi-tab', title: 'Multi Tab' },
        { name: 'loader-default', title: 'Loader default' },
        { name: 'loader-component', title: 'Loader Component' },
        { name: 'loader-priority', title: 'Loader priority' },
      ],
      has: (name: string) =>
        ['demo', 'multi-tab', 'loader-default', 'loader-component', 'loader-priority'].includes(name),
      get: (name: string) => {
        if (name === 'demo') {
          return { name: 'demo', title: 'Demo', Component: () => <div data-testid="demo-content">Demo Settings</div> };
        }
        if (name === 'multi-tab') {
          return {
            name: 'multi-tab',
            title: 'Multi Tab',
            children: [
              { name: 'multi-tab.tab1', key: 'tab1', title: 'Tab 1', Component: () => <div>Tab 1 Content</div> },
              { name: 'multi-tab.tab2', key: 'tab2', title: 'Tab 2', Component: () => <div>Tab 2 Content</div> },
            ],
          };
        }
        if (name === 'loader-default') {
          return {
            name,
            title: 'Loader default',
            componentLoader: async () => ({ default: () => <div>Loaded from default</div> }),
          };
        }
        if (name === 'loader-component') {
          return {
            name,
            title: 'Loader Component',
            componentLoader: async () => ({ Component: () => <div>Loaded from Component</div> }),
          };
        }
        if (name === 'loader-priority') {
          return {
            name,
            title: 'Loader priority',
            Component: () => <div>Direct Component</div>,
            componentLoader: async () => ({ default: () => <div>Loaded component</div> }),
          };
        }
        return undefined;
      },
    },
    getComponent: (name: string) =>
      name === 'RegistryComponent' ? () => <div>Loaded registry component</div> : undefined,
    i18n: { t: (key: string) => key },
    apiClient: { request: async () => ({ data: allowlist.records }) },
    eventBus: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
  }),
  useACLContext: () => ({ data: { data: { role: 'admin' } }, loading: false }),
}));

vi.mock('../locale', () => ({
  useT: () => (key: string) => key,
}));

vi.mock('../EmbedSettingsPluginSelect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../EmbedSettingsPluginSelect')>();
  return {
    ...actual,
    useEnabledEmbedSettingsPluginOptions: () => ({
      loading: false,
      options: allowlist.records.map((record) => ({ value: record.pluginName, label: record.title })),
    }),
  };
});

describe('EmbedSettingsBlock', () => {
  beforeEach(() => {
    allowlist.records = [
      { pluginName: 'demo', title: 'Demo' },
      { pluginName: 'multi-tab', title: 'Multi Tab' },
      { pluginName: 'loader-default', title: 'Loader default' },
      { pluginName: 'loader-component', title: 'Loader Component' },
      { pluginName: 'loader-priority', title: 'Loader priority' },
    ];
  });

  it('renders empty state when no pluginName provided', async () => {
    render(<EmbedSettingsBlock />);
    expect(await screen.findByText('Please select a plugin')).toBeTruthy();
  });

  it('renders empty state when plugin not found', async () => {
    render(<EmbedSettingsBlock pluginName="nonexistent" />);
    expect(await screen.findByText('Plugin not found or not authorized')).toBeTruthy();
  });

  it('renders empty state when the saved plugin is no longer on the allowlist', async () => {
    allowlist.records = [{ pluginName: 'demo', title: 'Demo' }];
    render(<EmbedSettingsBlock pluginName="multi-tab" />);
    expect(await screen.findByText('Plugin not found or not authorized')).toBeTruthy();
    expect(screen.queryByText('Tab 1 Content')).toBeNull();
    expect(screen.queryByText('Tab 2 Content')).toBeNull();
  });

  it('renders single tab content directly without Tabs wrapper', async () => {
    render(<EmbedSettingsBlock pluginName="demo" />);
    expect(await screen.findByTestId('demo-content')).toBeTruthy();
    expect(screen.getByText('Demo Settings')).toBeTruthy();
  });

  it('renders the component returned as the default export by a loader', async () => {
    render(<EmbedSettingsBlock pluginName="loader-default" />);
    expect(await screen.findByText('Loaded from default')).toBeTruthy();
  });

  it('renders the Component export from a loader module', async () => {
    render(<EmbedSettingsBlock pluginName="loader-component" />);
    expect(await screen.findByText('Loaded from Component')).toBeTruthy();
  });

  it('gives the loader precedence over a placeholder Component', async () => {
    render(<EmbedSettingsBlock pluginName="loader-priority" />);
    expect(await screen.findByText('Loaded component')).toBeTruthy();
    expect(screen.queryByText('Direct Component')).toBeNull();
  });

  it('renders multiple tabs with Tabs component', async () => {
    render(<EmbedSettingsBlock pluginName="multi-tab" />);
    expect(await screen.findByText('Tab 1')).toBeTruthy();
    expect(screen.getByText('Tab 2')).toBeTruthy();
  });

  it('filters tabs by enabledTabKeys - single tab renders content directly', async () => {
    render(<EmbedSettingsBlock pluginName="multi-tab" enabledTabKeys={['multi-tab.tab1']} />);
    // When only one tab is enabled, component renders content directly without Tabs wrapper
    expect(await screen.findByText('Tab 1 Content')).toBeTruthy();
    // Tab 2 content should not be present
    expect(screen.queryByText('Tab 2 Content')).toBeNull();
  });

  it('uses all available tabs when enabledTabKeys is undefined', async () => {
    render(<EmbedSettingsBlock pluginName="multi-tab" />);
    expect(await screen.findByText('Tab 1')).toBeTruthy();
    expect(screen.getByText('Tab 2')).toBeTruthy();
  });

  it('does not expand an explicit empty tab selection to all tabs', () => {
    render(<EmbedSettingsBlock pluginName="multi-tab" enabledTabKeys={[]} />);
    expect(screen.getByText('No tabs enabled')).toBeTruthy();
    expect(screen.queryByText('Tab 1')).toBeNull();
    expect(screen.queryByText('Tab 2')).toBeNull();
  });

  it('does not expose other tabs when every saved tab key has been removed', () => {
    render(<EmbedSettingsBlock pluginName="multi-tab" enabledTabKeys={['invalid-key']} />);
    expect(screen.getByText('No tabs enabled')).toBeTruthy();
    expect(screen.queryByText('Tab 1')).toBeNull();
    expect(screen.queryByText('Tab 2')).toBeNull();
  });
});
