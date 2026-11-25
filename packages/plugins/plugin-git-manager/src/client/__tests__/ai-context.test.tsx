// SPDX-License-Identifier: Apache-2.0

import { Registry } from '@nocobase/utils/client';
import { waitFor } from '@testing-library/react';
import type { AIManager } from '@nocobase/plugin-ai/client-v2';
import { actionData, fetchGitContext, type GitContextApp } from '../../client-v2/git-context-api';
import { registerGitWorkContexts } from '../../client-v2/ai-context';

type WorkContextRecord = {
  name?: string;
  menu?: { onClick?: unknown };
  getContent?: (app: unknown, item: { uid: string }) => Promise<unknown>;
};

function createManager() {
  const manager = {
    workContext: new Registry<WorkContextRecord>(),
    getWorkContext(name: string) {
      return this.workContext.get(name);
    },
    registerWorkContext(name: string, options: WorkContextRecord) {
      this.workContext.register(name, { ...options, name });
    },
  };
  return manager as unknown as AIManager & { workContext: Registry<WorkContextRecord> };
}

function actionResponse(data: unknown) {
  return { data: { data: { success: true, data } } };
}

describe('Git chat work contexts', () => {
  it('keeps menus hidden until capabilities load and updates them after authentication and role changes', async () => {
    const eventBus = new EventTarget();
    const responseHandlers: Array<(response: { config?: { url?: string } }) => unknown> = [];
    const pendingRequest = vi.fn();
    const app = {
      eventBus,
      apiClient: {
        auth: { token: 'test-token' },
        axios: {
          interceptors: {
            response: {
              use: (handler: (response: { config?: { url?: string } }) => unknown) => {
                responseHandlers.push(handler);
              },
            },
          },
        },
        request: pendingRequest,
      },
    } as unknown as GitContextApp;
    const manager = createManager();
    let resolveInitial: ((value: unknown) => void) | undefined;
    pendingRequest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInitial = resolve;
        }),
    );

    const registration = registerGitWorkContexts(app, manager);
    expect([...manager.workContext.getValues()].every((context) => !context.menu)).toBe(true);
    expect(registerGitWorkContexts(app, manager)).toBe(registration);
    expect(pendingRequest).toHaveBeenCalledWith({
      url: 'gitManager:chatContextOptions',
      skipNotify: true,
      timeout: 5000,
    });

    resolveInitial?.(actionResponse({ capabilities: { repository: true, 'merge-request': false, commit: false } }));
    await registration;
    expect(manager.workContext.get('git-repository')?.menu).toBeDefined();
    expect(manager.workContext.get('git-merge-request')?.menu).toBeUndefined();
    expect(manager.workContext.get('git-commit')?.menu).toBeUndefined();

    pendingRequest.mockResolvedValueOnce(
      actionResponse({ capabilities: { repository: false, 'merge-request': false, commit: true } }),
    );
    const roleCheck = responseHandlers[0]({ config: { url: '/api/roles:check' } });
    expect(roleCheck).toEqual({ config: { url: '/api/roles:check' } });
    await waitFor(() => {
      expect(manager.workContext.get('git-repository')?.menu).toBeUndefined();
      expect(manager.workContext.get('git-commit')?.menu).toBeDefined();
    });

    if (!app.apiClient.auth) throw new Error('Expected the authenticated API client');
    app.apiClient.auth.token = null;
    eventBus.dispatchEvent(new Event('auth:tokenChanged'));
    expect(manager.workContext.get('git-commit')?.menu).toBeUndefined();
    expect(pendingRequest).toHaveBeenCalledTimes(2);
  });

  it('unwraps an action response and refetches attached context by its stable uid', async () => {
    const contextData = { type: 'git-commit', repositoryId: 7, commitSha: 'a'.repeat(40), diff: '+value' };
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        actionResponse({ capabilities: { repository: false, 'merge-request': false, commit: true } }),
      )
      .mockResolvedValue(actionResponse(contextData));
    const app = { apiClient: { request }, eventBus: new EventTarget() } as GitContextApp;
    const manager = createManager();
    await registerGitWorkContexts(app, manager);

    expect(actionData(actionResponse(contextData))).toEqual(contextData);
    const reader = manager.workContext.get('git-commit')?.getContent;
    await expect(
      reader?.(app, { uid: `7:${'a'.repeat(40)}`, content: { type: 'git-commit', diff: 'stale content' } }),
    ).resolves.toEqual(contextData);
    await expect(fetchGitContext(app, 'commit', `7:${'a'.repeat(40)}`)).resolves.toEqual(contextData);
    expect(request).toHaveBeenCalledWith({
      url: 'gitManager:chatContextContent',
      params: { kind: 'commit', repositoryId: '7', commitHash: 'a'.repeat(40) },
      skipNotify: true,
    });
    expect(request).toHaveBeenCalledTimes(3);
  });
});
