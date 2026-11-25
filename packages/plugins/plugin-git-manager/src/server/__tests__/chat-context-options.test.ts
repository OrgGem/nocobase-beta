// SPDX-License-Identifier: Apache-2.0

import type { Context } from '@nocobase/actions';
import { chatContextOptions } from '../actions/chat-context';

type Permission = {
  params: {
    filter?: unknown;
    fields?: string[];
    whitelist?: string[];
    except?: string[];
    blacklist?: string[];
  };
} | null;

type RepositoryQuery = {
  filter?: unknown;
  fields?: string[];
  sort?: string[];
  limit?: number;
  offset?: number;
};

function scoped(ids: number[], fields?: string[]): Permission {
  return {
    params: {
      filter: { id: { $in: ids } },
      ...(fields ? { fields } : {}),
    },
  };
}

function createContext(input: {
  roles: string[];
  permissions: Record<string, Permission>;
  params: Record<string, unknown>;
  repository?: Record<string, unknown>;
  allowRoles?: string[];
}) {
  const repository = input.repository || {
    id: 1,
    name: 'Restricted repository',
    defaultBranch: 'main',
    status: 'ready',
  };
  const repositoryAccess = {
    findOne: vi.fn(async (_query: RepositoryQuery) => repository),
    find: vi.fn(async (_query: RepositoryQuery) => [repository]),
  };
  const can = vi.fn(async ({ roles, resource, action }: { roles: string[]; resource: string; action: string }) => {
    if (input.allowRoles && !input.allowRoles.every((role) => roles.includes(role))) return null;
    return input.permissions[`${resource}:${action}`] ?? null;
  });
  const getRepository = vi.fn(() => repositoryAccess);
  const context = {
    state: { currentUser: { id: 21 }, currentRoles: input.roles },
    action: { params: input.params },
    request: { body: {} },
    app: { acl: { can } },
    db: { getRepository },
    throw: vi.fn((status: number, message: string): never => {
      throw Object.assign(new Error(message), { status });
    }),
    body: undefined as unknown,
  };
  return { context: context as unknown as Context, can, repositoryAccess };
}

describe('Git AI chat context options permissions', () => {
  it('disables a kind when its per-action repository scopes have no common repository', async () => {
    const permissions: Record<string, Permission> = {
      'gitRepositories:list': scoped([1, 2]),
      'gitRepositories:get': scoped([1, 2]),
      'gitManager:branches': scoped([1]),
      'gitManager:log': scoped([2]),
      'gitManager:commitDetail': scoped([1, 2]),
      'gitManager:diff': scoped([1, 2]),
    };
    const { context, repositoryAccess } = createContext({
      roles: ['git-reader'],
      permissions,
      params: { kind: 'commit' },
    });

    await chatContextOptions(context, vi.fn().mockResolvedValue(undefined));

    expect(context.body).toMatchObject({
      success: true,
      data: {
        capabilities: { repository: true, 'merge-request': false, commit: false },
        items: [],
      },
    });
    expect(repositoryAccess.find).not.toHaveBeenCalled();
    expect(repositoryAccess.findOne).toHaveBeenCalledTimes(1);
  });

  it('combines joined roles and omits hidden names from results and search', async () => {
    const repositoryPermissions: Permission = scoped([1], ['id', 'defaultBranch', 'status']);
    const permissions: Record<string, Permission> = {
      'gitRepositories:list': repositoryPermissions,
      'gitRepositories:get': repositoryPermissions,
      'gitManager:branches': scoped([1]),
      'gitManager:log': scoped([1]),
      'gitManager:commitDetail': scoped([1]),
      'gitManager:diff': scoped([1]),
    };
    const roles = ['repository-reader', 'commit-reader'];
    const repository = { id: 1, name: 'Restricted repository', defaultBranch: 'main', status: 'ready' };
    const { context, can, repositoryAccess } = createContext({
      roles,
      allowRoles: roles,
      permissions,
      params: { kind: 'repository' },
      repository,
    });

    await chatContextOptions(context, vi.fn().mockResolvedValue(undefined));

    expect(can).toHaveBeenCalled();
    expect(can.mock.calls.every(([input]) => input.roles.join(',') === roles.join(','))).toBe(true);
    expect(context.body).toMatchObject({
      success: true,
      data: {
        capabilities: { repository: true, 'merge-request': false, commit: true },
        items: [{ id: 1, defaultBranch: 'main', status: 'ready' }],
      },
    });
    expect(JSON.stringify(context.body)).not.toContain('Restricted repository');

    const searchContext = createContext({
      roles,
      allowRoles: roles,
      permissions,
      params: { kind: 'repository', search: 'Restricted repository' },
      repository,
    });
    await chatContextOptions(searchContext.context, vi.fn().mockResolvedValue(undefined));

    expect(searchContext.context.body).toMatchObject({ success: true, data: { items: [] } });
    expect(searchContext.repositoryAccess.find).not.toHaveBeenCalled();
    expect(JSON.stringify(searchContext.context.body)).not.toContain('Restricted repository');
  });
});
