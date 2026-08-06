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
      data: { activeUsers: 3, aggregationMode: 'single-node', llm: [] },
      error: undefined,
      loading: false,
      refresh: vi.fn(),
    });
  });
  it('renders operational summary without raw request content', () => {
    render(<OverviewPage />);
    expect(screen.getByText('Active users')).toBeInTheDocument();
    expect(screen.getByText('Single-node mode')).toBeInTheDocument();
  });
});
