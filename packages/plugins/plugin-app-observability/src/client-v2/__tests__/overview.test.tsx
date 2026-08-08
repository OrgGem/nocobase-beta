import { render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import OverviewPage from '../pages/OverviewPage';

vi.mock('../locale', () => ({ useT: () => (key: string) => key }));
vi.mock('../hooks', () => ({ useVisiblePolling: vi.fn() }));
import { useVisiblePolling } from '../hooks';

describe('OverviewPage', () => {
  beforeEach(() => {
    vi.mocked(useVisiblePolling).mockReturnValue({
      data: {
        activeUsers: 3,
        activeUserScope: 'cluster-estimate',
        aggregationMode: 'single-node',
        llm: [
          { service: 'llm.chat', operation: 'chat', streaming: false },
          { service: 'llm.chat', operation: 'chat', streaming: true },
        ],
      },
      error: undefined,
      loading: false,
      refresh: vi.fn(),
    });
  });
  it('renders operational summary without raw request content', () => {
    render(<OverviewPage />);
    expect(screen.getByText('Active users (cluster estimate)')).toBeInTheDocument();
    expect(screen.getByText('Single-node mode')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-row-key="llm.chat:chat:standard"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-row-key="llm.chat:chat:stream"]')).toHaveLength(1);
  });
});
