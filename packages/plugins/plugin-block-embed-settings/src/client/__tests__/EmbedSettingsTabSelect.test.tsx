import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import { EmbedSettingsTabSelect } from '../EmbedSettingsTabSelect';

// Mock dependencies
vi.mock('@formily/react', () => ({
  useForm: () => ({ values: { pluginName: 'demo' } }),
}));

vi.mock('@formily/reactive-react', () => ({
  observer: (comp: unknown) => comp,
}));

vi.mock('@nocobase/client-v2', () => ({
  useApp: () => ({
    pluginSettingsManager: {
      has: (name: string) => name === 'demo',
      get: (name: string) =>
        name === 'demo'
          ? {
              name: 'demo',
              title: 'Demo',
              children: [
                { name: 'demo.tab1', key: 'tab1', title: 'Tab 1', Component: () => null },
                { name: 'demo.tab2', key: 'tab2', title: 'Tab 2', Component: () => null },
                { name: 'demo.tab3', key: 'tab3', title: 'Tab 3', Component: () => null },
              ],
            }
          : undefined,
    },
    i18n: { t: (key: string) => key },
  }),
}));

vi.mock('../locale', () => ({
  useT: () => (key: string) => key,
}));

describe('EmbedSettingsTabSelect', () => {
  it('renders checkboxes for all available tabs', () => {
    const onChange = vi.fn();
    render(<EmbedSettingsTabSelect value={['demo.tab1', 'demo.tab2', 'demo.tab3']} onChange={onChange} />);
    expect(screen.getByText('Tab 1')).toBeTruthy();
    expect(screen.getByText('Tab 2')).toBeTruthy();
    expect(screen.getByText('Tab 3')).toBeTruthy();
  });

  it('shows helper text about enabled tabs', () => {
    const onChange = vi.fn();
    render(<EmbedSettingsTabSelect value={['demo.tab1']} onChange={onChange} />);
    expect(screen.getByText('Only enabled tabs will be shown in the block')).toBeTruthy();
  });

  it('calls onChange when checkbox is toggled', () => {
    const onChange = vi.fn();
    render(<EmbedSettingsTabSelect value={['demo.tab1', 'demo.tab2', 'demo.tab3']} onChange={onChange} />);
    fireEvent.click(screen.getByText('Tab 2'));
    expect(onChange).toHaveBeenCalled();
  });
});