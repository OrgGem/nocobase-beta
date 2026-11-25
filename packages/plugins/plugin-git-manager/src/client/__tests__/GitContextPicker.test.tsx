// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { GitContextApp } from '../../client-v2/git-context-api';
import { GitContextPicker } from '../../client-v2/components/GitContextPicker';
import { setCurrentGitRepository } from '../../client-v2/git-context-api';

const mocks = vi.hoisted(() => ({ t: (key: string) => key }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.t }),
}));

const actionResponse = (data: unknown, extra: Record<string, unknown> = {}) => ({
  data: { data: { success: true, data, ...extra } },
});

describe('GitContextPicker', () => {
  afterEach(() => {
    cleanup();
  });

  it('preselects an authorized repository and rechecks a selected commit before attaching only its uid and title', async () => {
    const commitHash = 'a'.repeat(40);
    const repository = { id: 7, name: 'backend', defaultBranch: 'main', status: 'connected' };
    const request = vi.fn(async ({ url, params }: { url: string; params?: Record<string, unknown> }) => {
      if (url === 'gitManager:chatContextOptions') {
        return actionResponse({ items: [repository], hasMore: false });
      }
      if (url === 'gitManager:branches') {
        return actionResponse({ all: ['main', 'release'], current: 'release', detached: false });
      }
      if (url === 'gitManager:log') {
        return actionResponse({
          all: [{ hash: commitHash, subject: 'Fix access checks', author_name: 'Maya', date: '2026-10-20T10:00:00Z' }],
        });
      }
      if (url === 'gitManager:chatContextContent') {
        return actionResponse({ type: 'git-commit', repositoryId: 7, commitSha: commitHash, diff: '+secure' });
      }
      throw new Error(`Unexpected API request ${url} ${JSON.stringify(params)}`);
    });
    const app = { apiClient: { request }, eventBus: new EventTarget() } as GitContextApp;
    const onAdd = vi.fn();
    const onClose = vi.fn();
    setCurrentGitRepository(app, repository.id);

    render(<GitContextPicker app={app} kind="commit" onAdd={onAdd} onClose={onClose} />);

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'gitManager:chatContextOptions',
          params: { kind: 'commit', repositoryId: 7, page: 1, pageSize: 1 },
        }),
      ),
    );
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'gitManager:log',
          params: { repositoryId: 7, branch: 'release', skip: 0, maxCount: 30 },
        }),
      ),
    );

    fireEvent.mouseDown(await screen.findByRole('combobox', { name: 'Commit' }));
    fireEvent.click(await screen.findByText(/aaaaaaa · Fix access checks · Maya/));
    fireEvent.click(screen.getByRole('button', { name: 'Attach to chat' }));

    await waitFor(() =>
      expect(onAdd).toHaveBeenCalledWith({
        uid: `7:${commitHash}`,
        title: 'backend · aaaaaaa · Fix access checks',
      }),
    );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'gitManager:chatContextContent',
        params: { kind: 'commit', repositoryId: '7', commitHash },
      }),
    );
    const contentRequestIndex = request.mock.calls.findIndex(
      ([config]) => config.url === 'gitManager:chatContextContent',
    );
    expect(request.mock.invocationCallOrder[contentRequestIndex]).toBeLessThan(onAdd.mock.invocationCallOrder[0]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(onAdd.mock.calls[0][0])).not.toContain('diff');
    setCurrentGitRepository(app);
  });

  it('keeps an empty GitHub merged page loadable when the server reports a next page', async () => {
    const repository = { id: 9, name: 'frontend', defaultBranch: 'main', status: 'connected' };
    const request = vi.fn(async ({ url }: { url: string }) => {
      if (url === 'gitManager:chatContextOptions') return actionResponse({ items: [repository], hasMore: false });
      if (url === 'gitManager:mergeRequests') {
        return actionResponse([], { pagination: { totalPages: null, hasMore: true } });
      }
      throw new Error(`Unexpected API request ${url}`);
    });
    const app = { apiClient: { request }, eventBus: new EventTarget() } as GitContextApp;
    setCurrentGitRepository(app, repository.id);

    render(<GitContextPicker app={app} kind="merge-request" onAdd={vi.fn()} onClose={vi.fn()} />);

    const loadMore = await screen.findByRole('button', { name: 'Load more results' });
    fireEvent.click(loadMore);

    await waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'gitManager:mergeRequests',
          params: { repositoryId: 9, state: 'opened', page: 2, perPage: 30 },
        }),
      );
    });
    setCurrentGitRepository(app);
  });
});
