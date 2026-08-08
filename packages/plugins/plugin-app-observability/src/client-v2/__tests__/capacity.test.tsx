import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import CapacityPage from '../pages/CapacityPage';

vi.mock('../locale', () => ({ useT: () => (key: string) => key }));
vi.mock('../hooks', () => ({
  useVisiblePolling: () => ({
    data: { state: 'watch', confidence: 0.7, recommendation: { key: 'Watch CPU' }, signals: [] },
    error: undefined,
    loading: false,
    refresh: vi.fn(),
  }),
}));
describe('CapacityPage', () => {
  it('states that recommendations never auto-scale resources', () => {
    render(<CapacityPage />);
    expect(screen.getByText(/never auto-scales/)).toBeInTheDocument();
    expect(screen.getByText('Watch CPU')).toBeInTheDocument();
  });
});
