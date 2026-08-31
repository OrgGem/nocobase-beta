import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import { EmbedSettingsBlock } from '../EmbedSettingsBlock';

// Mock dependencies
vi.mock('@formily/react', () => ({
  useFieldSchema: () => ({ 'x-component-props': {} }),
}));

vi.mock('@nocobase/client-v2', () => ({
  useApp: () => ({
    pluginSettingsManager: {
      has: (name: string) => name === 'demo' || name === 'multi-tab',
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
        return undefined;
      },
    },
    i18n: { t: (key: string) => key },
  }),
}));

vi.mock('../locale', () => ({
  useT: () => (key: string) => key,
}));

describe('EmbedSettingsBlock', () => {
  it('renders empty state when no pluginName provided', () => {
    render(<EmbedSettingsBlock />);
    expect(screen.getByText('Please select a plugin')).toBeTruthy();
  });

  it('renders empty state when plugin not found', () => {
    render(<EmbedSettingsBlock pluginName="nonexistent" />);
    expect(screen.getByText('Plugin not found or not authorized')).toBeTruthy();
  });

  it('renders single tab content directly without Tabs wrapper', () => {
    render(<EmbedSettingsBlock pluginName="demo" />);
    expect(screen.getByTestId('demo-content')).toBeTruthy();
    expect(screen.getByText('Demo Settings')).toBeTruthy();
  });

  it('renders multiple tabs with Tabs component', () => {
    render(<EmbedSettingsBlock pluginName="multi-tab" />);
    expect(screen.getByText('Tab 1')).toBeTruthy();
    expect(screen.getByText('Tab 2')).toBeTruthy();
  });

  it('filters tabs by enabledTabKeys - single tab renders content directly', () => {
    render(<EmbedSettingsBlock pluginName="multi-tab" enabledTabKeys={['multi-tab.tab1']} />);
    // When only one tab is enabled, component renders content directly without Tabs wrapper
    expect(screen.getByText('Tab 1 Content')).toBeTruthy();
    // Tab 2 content should not be present
    expect(screen.queryByText('Tab 2 Content')).toBeNull();
  });

  it('falls back to all tabs when enabledTabKeys has no valid entries', () => {
    render(<EmbedSettingsBlock pluginName="multi-tab" enabledTabKeys={['invalid-key']} />);
    expect(screen.getByText('Tab 1')).toBeTruthy();
    expect(screen.getByText('Tab 2')).toBeTruthy();
  });
});