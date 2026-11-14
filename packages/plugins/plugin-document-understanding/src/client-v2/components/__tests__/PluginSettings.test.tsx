// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PluginSettings } from '../PluginSettings';

vi.mock('../../locale', () => ({ useT: () => (key: string) => key }));
vi.mock('../ServiceConfigTab', () => ({ ServiceConfigTab: () => <div>Service configuration content</div> }));
vi.mock('../EndpointsTab', () => ({ EndpointsTab: () => <div>Endpoint content</div> }));
vi.mock('../PipelinesTab', () => ({ PipelinesTab: () => <div>Pipeline content</div> }));
vi.mock('../JobsTab', () => ({ JobsTab: () => <div>Job content</div> }));

describe('Document Understanding plugin settings layout', () => {
  it('omits the standalone page heading and full-page height when embedded while keeping the settings tabs', () => {
    const view = render(<PluginSettings embedded />);
    const root = view.container.firstElementChild as HTMLElement;
    const content = root.firstElementChild as HTMLElement;

    expect(screen.queryByRole('heading', { name: 'Document Understanding - Pipeline Orchestrator' })).toBeNull();
    expect(root.style.minHeight).toBe('');
    expect(content.style.padding).toBe('0px');
    expect(screen.getByRole('tab', { name: 'Service Config' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Endpoints' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Pipelines' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Jobs history' })).toBeTruthy();
  });

  it('keeps the heading, full-page height, and padding in standalone settings', () => {
    const view = render(<PluginSettings />);
    const root = view.container.firstElementChild as HTMLElement;
    const headingWrapper = root.firstElementChild as HTMLElement;
    const content = headingWrapper.nextElementSibling as HTMLElement;

    expect(screen.getByRole('heading', { name: 'Document Understanding - Pipeline Orchestrator' })).toBeTruthy();
    expect(root.style.minHeight).toBe('100vh');
    expect(content.style.padding).toBe('0px 24px 24px');
  });
});
