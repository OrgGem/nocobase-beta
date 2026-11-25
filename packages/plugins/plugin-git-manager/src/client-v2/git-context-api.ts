// SPDX-License-Identifier: Apache-2.0

export type GitContextKind = 'repository' | 'merge-request' | 'commit';
export type GitContextApp = {
  apiClient: {
    request: (config: {
      url: string;
      params?: Record<string, unknown>;
      skipNotify?: boolean;
      timeout?: number;
    }) => Promise<unknown>;
    auth?: { token?: string | null };
  };
  eventBus: EventTarget;
};

const currentRepositories = new WeakMap<object, number>();

export function setCurrentGitRepository(app: object, repositoryId?: number) {
  if (repositoryId == null) currentRepositories.delete(app);
  else currentRepositories.set(app, repositoryId);
}

export function getCurrentGitRepository(app: object): number | undefined {
  return currentRepositories.get(app);
}

export function actionBody(response: unknown): unknown {
  return (response as { data?: { data?: unknown } } | null)?.data?.data;
}

export function actionData(response: unknown): unknown {
  const body = actionBody(response);
  if (body && typeof body === 'object' && 'success' in body && 'data' in body) {
    return (body as { data: unknown }).data;
  }
  return body;
}

function contextParams(kind: GitContextKind, uid: string): Record<string, unknown> {
  if (kind === 'repository') return { kind, repositoryId: uid };
  const separator = uid.indexOf(':');
  const repositoryId = uid.slice(0, separator);
  const target = uid.slice(separator + 1);
  if (separator <= 0 || !target) throw new Error('Invalid Git context');
  if (kind === 'merge-request') return { kind, repositoryId, mrIid: target };
  return { kind, repositoryId, commitHash: target };
}

export async function fetchGitContext(app: GitContextApp, kind: GitContextKind, uid: string): Promise<unknown> {
  const response = await app.apiClient.request({
    url: 'gitManager:chatContextContent',
    params: contextParams(kind, uid),
    skipNotify: true,
  });
  const data = actionData(response);
  if (!data || typeof data !== 'object') throw new Error('Git context is unavailable');
  return data;
}
