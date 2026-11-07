/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RunReviewButton } from '../components/RunReviewButton';

const mocks = vi.hoisted(() => ({ request: vi.fn(), getPlugin: vi.fn(), triggerTask: vi.fn() }));
vi.mock('@nocobase/client-v2', () => ({
  useApp: () => ({ apiClient: { request: mocks.request }, pm: { get: mocks.getPlugin } }),
}));
vi.mock('../locale', () => ({ useT: () => (key: string) => key }));
// Any accidental runtime import of the optional AI package must fail this suite.
vi.mock('@nocobase/plugin-ai', () => {
  throw new Error('Unexpected legacy AI import');
});
vi.mock('@nocobase/plugin-ai/client-v2', () => {
  throw new Error('Unexpected mandatory AI import');
});

describe('RunReviewButton optional AI integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPlugin.mockReturnValue(undefined);
    mocks.request.mockImplementation(async ({ url }: { url: string }) => ({
      data: {
        data: url === 'gitReviewFlows:list' ? [{ id: 1, name: 'Security', aiEmployeeUsername: 'reviewer' }] : [],
      },
    }));
  });
  afterEach(cleanup);

  it('renders Git review controls without the AI plugin and disables only chat', async () => {
    render(<RunReviewButton target={{ type: 'branch', repositoryId: 7, branch: 'main' }} />);
    fireEvent.click(screen.getByRole('button', { name: /Code Review/ }));
    const chat = await screen.findByRole('menuitem', { name: /Ask AI Employee/ });
    expect(chat.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('menuitem', { name: /Run automated review/ }).getAttribute('aria-disabled')).not.toBe(
      'true',
    );
  });

  it('opens a contextual task through the installed AI manager', async () => {
    mocks.getPlugin.mockReturnValue({ aiManager: { triggerTask: mocks.triggerTask } });
    render(<RunReviewButton target={{ type: 'mr', repositoryId: 7, mrIid: 42, title: 'Fix permissions' }} />);
    fireEvent.click(screen.getByRole('button', { name: /Code Review/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Ask AI Employee/ }));
    await waitFor(() => expect(mocks.triggerTask).toHaveBeenCalledTimes(1));
    expect(mocks.triggerTask).toHaveBeenCalledWith({
      aiEmployee: 'reviewer',
      tasks: [
        expect.objectContaining({
          autoSend: false,
          message: expect.objectContaining({
            workContext: [
              expect.objectContaining({
                type: 'git-merge-request',
                content: { repositoryId: 7, mrIid: 42, title: 'Fix permissions' },
              }),
            ],
          }),
        }),
      ],
    });
    expect(mocks.getPlugin).toHaveBeenCalledWith('ai');
  });
});
