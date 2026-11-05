/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import PaginationSettingsPage from '../pages/PaginationSettingsPage';

const { request, context } = vi.hoisted(() => {
  const request = vi.fn();
  return { request, context: { api: { request } } };
});

it('does not save fallback defaults when loading the existing settings fails', async () => {
  request.mockRejectedValueOnce(new Error('Settings unavailable'));
  render(<PaginationSettingsPage />);
  await screen.findByText('Settings unavailable');
  const save = screen.getByRole('button', { name: 'Save' });
  expect(save).toHaveProperty('disabled', true);
  fireEvent.click(save);
  expect(request).toHaveBeenCalledTimes(1);
});
vi.mock('@nocobase/flow-engine', () => ({ useFlowContext: () => context }));
vi.mock('../locale', () => ({ useT: () => (key: string) => key }));
beforeEach(() => {
  request.mockReset();
});

it('loads a wrapped cursor setting and saves it without replacing it with the offset default', async () => {
  request
    .mockResolvedValueOnce({ data: { data: { paginationMode: 'cursor' } } })
    .mockResolvedValue({ data: { data: { success: true } } });
  render(<PaginationSettingsPage />);
  await screen.findByText('Cursor (opt-in API)');
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({
      url: 'databasePlusManager:saveSettings',
      method: 'post',
      data: { paginationMode: 'cursor' },
    }),
  );
});
