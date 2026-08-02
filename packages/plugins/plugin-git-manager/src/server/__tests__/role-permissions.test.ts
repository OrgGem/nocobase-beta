import type { Database, Model } from '@nocobase/database';
import { vi } from 'vitest';

import {
  getRepositoryPermissionIds,
  getRepositoryPermissionScope,
  repositoryPermissionIdsForDisplay,
  syncScopedActions,
} from '../actions/role-permissions';

function permissionAction(name: string, repositoryIds: Array<number | string>) {
  return {
    toJSON: () => ({
      name,
      scope: { scope: { $and: [{ id: { $in: repositoryIds } }] } },
    }),
  } as unknown as Model;
}

describe('Git Manager role permissions', () => {
  it('reads repository IDs from legacy scoped actions', () => {
    const actions = [permissionAction('read', [1]), permissionAction('write', [1, 2])];

    expect(getRepositoryPermissionIds(actions, ['read', 'write'])).toEqual([1, 2]);
  });

  it('does not include repository IDs from unrelated actions', () => {
    const actions = [permissionAction('destroy', [3]), permissionAction('write', [1])];

    expect(getRepositoryPermissionIds(actions, ['write'])).toEqual([1]);
  });

  it('preserves direct and equality repository scopes from legacy roles', () => {
    const directScope = {
      toJSON: () => ({
        name: 'read',
        scope: { scope: { $and: [{ id: 42 }] } },
      }),
    } as unknown as Model;
    const equalityScope = {
      toJSON: () => ({
        name: 'write',
        scope: { scope: { $or: [{ id: { $eq: '43' } }, { id: { $in: [44] } }] } },
      }),
    } as unknown as Model;

    expect(getRepositoryPermissionIds([directScope, equalityScope], ['read', 'write'])).toEqual([42, '43', 44]);
  });

  it('recognizes an unscoped legacy permission as access to every repository', () => {
    const unscopedAction = {
      toJSON: () => ({ name: 'read' }),
    } as unknown as Model;

    expect(getRepositoryPermissionScope([unscopedAction], ['read'])).toEqual({
      ids: [],
      unrestricted: true,
      supported: true,
    });
  });

  it('expands an unrestricted scope to the repository IDs shown by the role editor', () => {
    expect(repositoryPermissionIdsForDisplay({ ids: [], unrestricted: true, supported: true }, [1, 2])).toEqual([1, 2]);
    expect(repositoryPermissionIdsForDisplay({ ids: [], unrestricted: false, supported: true }, [1, 2])).toEqual([]);
  });

  it('does not widen a legacy scope whose repository conditions intersect', () => {
    const intersectingScope = {
      toJSON: () => ({
        name: 'read',
        scope: { scope: { $and: [{ id: { $in: [1, 2] } }, { id: { $in: [2, 3] } }] } },
      }),
    } as unknown as Model;

    expect(getRepositoryPermissionScope([intersectingScope], ['read'])).toEqual({
      ids: [2],
      unrestricted: false,
      supported: true,
    });
  });

  it('marks unsupported legacy scopes as unsafe to migrate', () => {
    const unsupportedScope = {
      toJSON: () => ({
        name: 'read',
        scope: { scope: { $and: [{ id: { $in: [1] } }, { status: 'active' }] } },
      }),
    } as unknown as Model;

    expect(getRepositoryPermissionScope([unsupportedScope], ['read'])).toEqual({
      ids: [],
      unrestricted: false,
      supported: false,
    });
  });

  it('creates unscoped v2 actions when migrating an unrestricted legacy permission', async () => {
    const actionsRepository = {
      findOne: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(undefined),
    };
    const db = {
      getRepository: vi.fn((name: string) => {
        if (name === 'rolesResourcesActions') return actionsRepository;
        throw new Error(`Unexpected repository ${name}`);
      }),
    } as unknown as Database;
    const resource = {
      get: (attribute: string) => (attribute === 'id' ? 1 : undefined),
    } as unknown as Model;

    await syncScopedActions(db, resource, ['fileContent'], [], { unrestricted: true });

    expect(actionsRepository.create).toHaveBeenCalledWith({
      values: { rolesResourceId: 1, name: 'fileContent' },
    });
  });

  it('persists a deny-all scope instead of deleting a zero-selection action', async () => {
    const actionsRepository = {
      findOne: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(undefined),
    };
    const scopesRepository = {
      create: vi.fn().mockResolvedValue({ get: (attribute: string) => (attribute === 'id' ? 99 : undefined) }),
    };
    const db = {
      getRepository: vi.fn((name: string) => {
        if (name === 'rolesResourcesActions') return actionsRepository;
        if (name === 'rolesResourcesScopes') return scopesRepository;
        throw new Error(`Unexpected repository ${name}`);
      }),
    } as unknown as Database;
    const resource = {
      get: (attribute: string) => (attribute === 'id' ? 1 : undefined),
    } as unknown as Model;

    await syncScopedActions(db, resource, ['fileContent'], []);

    expect(scopesRepository.create).toHaveBeenCalledWith({
      values: { scope: { $and: [{ id: { $in: [] } }] } },
    });
    expect(actionsRepository.create).toHaveBeenCalledWith({
      values: { rolesResourceId: 1, name: 'fileContent', scopeId: 99 },
    });
  });
});
