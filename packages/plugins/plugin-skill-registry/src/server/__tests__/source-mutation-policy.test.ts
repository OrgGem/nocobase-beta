import { createSourceMutationPolicy } from '../middlewares/source-mutation-policy';
import { normalizeIdentity, normalizeSourceCreateValues, normalizeSourceUpdateValues } from '../services/validation';

function sourceModel(values: Record<string, unknown>) {
  return { get: (attribute: string) => values[attribute] };
}

function sourceContext(actionName: string, params: Record<string, unknown>) {
  return {
    action: {
      resourceName: 'skillRegistrySources',
      actionName,
      params,
    },
  };
}

describe('skill registry source mutation policy', () => {
  it('accepts only source configuration fields and provider-specific allowlists', () => {
    expect(
      normalizeSourceCreateValues({
        name: ' Git source ',
        providerType: 'git-manager',
        namespace: 'Acme',
        providerConfig: { repositoryId: 12, ref: 'refs/heads/main', rootPath: './skills/' },
        enabled: true,
        syncPolicy: 'manual',
      }),
    ).toEqual({
      name: 'Git source',
      providerType: 'git-manager',
      namespace: 'acme',
      providerConfig: { repositoryId: 12, ref: 'refs/heads/main', rootPath: 'skills' },
      enabled: true,
      syncPolicy: 'manual',
      syncIntervalMinutes: null,
    });

    expect(
      normalizeSourceCreateValues({
        name: 'Hub source',
        providerType: 'skill-hub',
        namespace: 'team',
        providerConfig: { skillDefinitionIds: ['1', 2] },
      }).providerConfig,
    ).toEqual({ skillDefinitionIds: ['1', 2] });

    for (const values of [
      { status: 'ready' },
      { id: 'source-1' },
      { createdById: 'user-1' },
      { providerConfig: { repositoryId: 1, ref: 'main', extra: true }, providerType: 'git-manager' },
      { providerConfig: { nested: { ToKeN: 'secret' } }, providerType: 'skill-hub' },
      { providerConfig: { Registry_Export_Enabled: true }, providerType: 'skill-hub' },
      { providerConfig: { skillDefinitionIds: null }, providerType: 'skill-hub' },
      { providerConfig: { repositoryId: 1, ref: 'main', rootPath: null }, providerType: 'git-manager' },
    ]) {
      expect(() =>
        normalizeSourceCreateValues({
          name: 'source',
          providerType: 'skill-hub',
          namespace: 'team',
          providerConfig: {},
          ...values,
        }),
      ).toThrow(expect.objectContaining({ code: 'INVALID_MANIFEST', status: 422 }));
    }
  });

  it('enforces database identity lengths and validates complete partial-update state', () => {
    expect(() => normalizeIdentity('n'.repeat(81), 'namespace')).toThrow(
      expect.objectContaining({ code: 'INVALID_MANIFEST', status: 422 }),
    );
    expect(() => normalizeIdentity('s'.repeat(121), 'slug')).toThrow(
      expect.objectContaining({ code: 'INVALID_MANIFEST', status: 422 }),
    );

    const current = {
      name: 'source',
      providerType: 'git-manager',
      namespace: 'team',
      providerConfig: { repositoryId: 1, ref: 'main', rootPath: 'skills' },
      enabled: true,
      syncPolicy: 'interval',
      syncIntervalMinutes: 10,
    };
    expect(normalizeSourceUpdateValues(current, { enabled: false })).toEqual({ enabled: false });
    expect(() => normalizeSourceUpdateValues(current, { syncIntervalMinutes: null })).toThrow(
      expect.objectContaining({ code: 'INVALID_MANIFEST', status: 422 }),
    );
    expect(() => normalizeSourceUpdateValues(current, { status: 'error' })).toThrow(
      expect.objectContaining({ code: 'INVALID_MANIFEST', status: 422 }),
    );
  });

  it('leaves create unlocked but rejects update and destroy while the shared source lock is busy', async () => {
    const tryAcquire = vi.fn().mockRejectedValue(new Error('lock unavailable'));
    const database = {
      getRepository: vi.fn(() => ({ findOne: vi.fn() })),
    };
    const middleware = createSourceMutationPolicy({
      database: database as never,
      lockManager: { tryAcquire } as never,
    });
    const next = vi.fn().mockResolvedValue(undefined);
    const create = sourceContext('create', {
      values: { name: 'source', providerType: 'skill-hub', namespace: 'team', providerConfig: {} },
    });

    await middleware(create as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(tryAcquire).not.toHaveBeenCalled();

    for (const actionName of ['update', 'destroy']) {
      const context = sourceContext(actionName, {
        filterByTk: 'source-1',
        ...(actionName === 'update' ? { values: { enabled: false } } : {}),
      });
      await expect(middleware(context as never, next)).rejects.toMatchObject({
        code: 'REGISTRY_OPERATION_BUSY',
        status: 409,
      });
    }
    expect(tryAcquire).toHaveBeenCalledTimes(2);
    expect(tryAcquire).toHaveBeenNthCalledWith(1, 'skill-registry:source:source-1', 0);
    expect(tryAcquire).toHaveBeenNthCalledWith(2, 'skill-registry:source:source-1', 0);
  });

  it('merges and normalizes an update while holding the same source lock used by sync/publish', async () => {
    const runExclusive = vi.fn(async <T>(operation: () => Promise<T>) => operation());
    const tryAcquire = vi.fn().mockResolvedValue({ runExclusive });
    const existing = sourceModel({
      name: 'source',
      providerType: 'skill-hub',
      namespace: 'Team',
      providerConfig: {},
      enabled: true,
      syncPolicy: 'manual',
      syncIntervalMinutes: null,
    });
    const findActiveSync = vi.fn().mockResolvedValue(null);
    const findSource = vi.fn().mockResolvedValue(existing);
    const getRepository = vi.fn((name: string) =>
      name === 'skillRegistrySyncRuns' ? { findOne: findActiveSync } : { findOne: findSource },
    );
    const middleware = createSourceMutationPolicy({
      database: { getRepository } as never,
      lockManager: { tryAcquire } as never,
    });
    const context = sourceContext('update', {
      filterByTk: 'source-1',
      values: { namespace: 'New-Team', syncPolicy: 'manual' },
    });
    const next = vi.fn(async () => {
      expect(context.action.params.values).toEqual({
        namespace: 'new-team',
        syncPolicy: 'manual',
        syncIntervalMinutes: null,
      });
    });

    await middleware(context as never, next);

    expect(findActiveSync).toHaveBeenCalledWith({ filter: { activeKey: 'source-1' } });
    expect(findSource).toHaveBeenCalledWith({ filterByTk: 'source-1' });
    expect(runExclusive).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects a source mutation when the database fence still has an active sync run', async () => {
    const runExclusive = vi.fn(async <T>(operation: () => Promise<T>) => operation());
    const tryAcquire = vi.fn().mockResolvedValue({ runExclusive });
    const findActiveSync = vi.fn().mockResolvedValue(sourceModel({ id: 'run-1' }));
    const findSource = vi.fn();
    const middleware = createSourceMutationPolicy({
      database: {
        getRepository: vi.fn((name: string) =>
          name === 'skillRegistrySyncRuns' ? { findOne: findActiveSync } : { findOne: findSource },
        ),
      } as never,
      lockManager: { tryAcquire } as never,
    });
    const context = sourceContext('update', {
      filterByTk: 'source-1',
      values: { enabled: false },
    });
    const next = vi.fn().mockResolvedValue(undefined);

    await expect(middleware(context as never, next)).rejects.toMatchObject({
      code: 'REGISTRY_OPERATION_BUSY',
      status: 409,
    });

    expect(findActiveSync).toHaveBeenCalledWith({ filter: { activeKey: 'source-1' } });
    expect(findSource).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('requires Git Manager to authorize the current user before saving a Git source binding', async () => {
    const assertAccess = vi.fn().mockResolvedValue(undefined);
    const middleware = createSourceMutationPolicy({
      database: { getRepository: vi.fn() } as never,
      providers: new Map([
        [
          'git-manager',
          {
            type: 'git-manager',
            assertAccess,
          } as never,
        ],
      ]),
    });
    const context = {
      ...sourceContext('create', {
        values: {
          name: 'Git source',
          providerType: 'git-manager',
          namespace: 'team',
          providerConfig: { repositoryId: 42, ref: 'main', rootPath: 'skills' },
        },
      }),
      auth: { user: { id: 'admin-1' } },
      state: { currentRoles: ['registry-manager'] },
    };
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(context as never, next);

    expect(assertAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'new-source',
        providerType: 'git-manager',
        providerConfig: { repositoryId: 42, ref: 'main', rootPath: 'skills' },
      }),
      { kind: 'user', userId: 'admin-1', roles: ['registry-manager'] },
    );
    expect(context.action.params.values).toEqual(
      expect.objectContaining({
        providerAccessAuthorizedById: 'admin-1',
        providerAccessAuthorizedAt: expect.any(Date),
      }),
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it('allows non-binding updates to a Git source when Git Manager is unavailable or the actor has lost repository scope', async () => {
    const existing = sourceModel({
      name: 'Git source',
      providerType: 'git-manager',
      namespace: 'team',
      providerConfig: { repositoryId: 42, ref: 'main', rootPath: 'skills' },
      enabled: true,
      syncPolicy: 'manual',
      syncIntervalMinutes: null,
      providerAccessAuthorizedAt: new Date(),
    });
    const getRepository = vi.fn((name: string) =>
      name === 'skillRegistrySyncRuns'
        ? { findOne: vi.fn().mockResolvedValue(null) }
        : { findOne: vi.fn().mockResolvedValue(existing) },
    );
    const unavailableMiddleware = createSourceMutationPolicy({ database: { getRepository } as never });
    const disableContext = sourceContext('update', {
      filterByTk: 'source-1',
      values: { enabled: false },
    });
    const disabled = vi.fn().mockResolvedValue(undefined);

    await expect(unavailableMiddleware(disableContext as never, disabled)).resolves.toBeUndefined();
    expect(disableContext.action.params.values).toEqual({ enabled: false });
    expect(disabled).toHaveBeenCalledOnce();

    const assertAccess = vi.fn().mockRejectedValue(new Error('repository scope was revoked'));
    const deniedMiddleware = createSourceMutationPolicy({
      database: { getRepository } as never,
      providers: new Map([['git-manager', { type: 'git-manager', assertAccess } as never]]),
    });
    const renameContext = {
      ...sourceContext('update', {
        filterByTk: 'source-1',
        values: { name: 'Archived Git source' },
      }),
      auth: { user: { id: 'admin-1' } },
      state: { currentRoles: ['registry-manager'] },
    };
    const renamed = vi.fn().mockResolvedValue(undefined);

    await expect(deniedMiddleware(renameContext as never, renamed)).resolves.toBeUndefined();
    expect(renameContext.action.params.values).toEqual({ name: 'Archived Git source' });
    expect(assertAccess).not.toHaveBeenCalled();
    expect(renamed).toHaveBeenCalledOnce();
  });

  it('reauthorizes a legacy Git source without changing its binding', async () => {
    const existing = sourceModel({
      name: 'Git source',
      providerType: 'git-manager',
      namespace: 'team',
      providerConfig: { repositoryId: 42, ref: 'main', rootPath: 'skills' },
      enabled: true,
      syncPolicy: 'manual',
      syncIntervalMinutes: null,
      providerAccessAuthorizedAt: null,
    });
    const assertAccess = vi.fn().mockResolvedValue(undefined);
    const middleware = createSourceMutationPolicy({
      database: {
        getRepository: vi.fn((name: string) =>
          name === 'skillRegistrySyncRuns'
            ? { findOne: vi.fn().mockResolvedValue(null) }
            : { findOne: vi.fn().mockResolvedValue(existing) },
        ),
      } as never,
      providers: new Map([['git-manager', { type: 'git-manager', assertAccess } as never]]),
    });
    const context = {
      ...sourceContext('update', {
        filterByTk: 'source-1',
        values: { name: 'Renamed Git source' },
      }),
      auth: { user: { id: 'admin-1' } },
      state: { currentRoles: ['registry-manager'] },
    };
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(context as never, next);

    expect(assertAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'source-1',
        providerConfig: { repositoryId: 42, ref: 'main', rootPath: 'skills' },
      }),
      { kind: 'user', userId: 'admin-1', roles: ['registry-manager'] },
    );
    expect(context.action.params.values).toEqual(
      expect.objectContaining({
        name: 'Renamed Git source',
        providerAccessAuthorizedAt: expect.any(Date),
        providerAccessAuthorizedById: 'admin-1',
      }),
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it('reauthorizes a Git source when its effective binding changes', async () => {
    const existing = sourceModel({
      name: 'Git source',
      providerType: 'git-manager',
      namespace: 'team',
      providerConfig: { repositoryId: 42, ref: 'main', rootPath: 'skills' },
      enabled: true,
      syncPolicy: 'manual',
      syncIntervalMinutes: null,
    });
    const assertAccess = vi.fn().mockResolvedValue(undefined);
    const middleware = createSourceMutationPolicy({
      database: {
        getRepository: vi.fn((name: string) =>
          name === 'skillRegistrySyncRuns'
            ? { findOne: vi.fn().mockResolvedValue(null) }
            : { findOne: vi.fn().mockResolvedValue(existing) },
        ),
      } as never,
      providers: new Map([['git-manager', { type: 'git-manager', assertAccess } as never]]),
    });
    const context = {
      ...sourceContext('update', {
        filterByTk: 'source-1',
        values: { providerConfig: { repositoryId: 42, ref: 'release', rootPath: 'skills' } },
      }),
      auth: { user: { id: 'admin-1' } },
      state: { currentRoles: ['registry-manager'] },
    };
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(context as never, next);

    expect(assertAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'source-1',
        providerType: 'git-manager',
        providerConfig: { repositoryId: 42, ref: 'release', rootPath: 'skills' },
      }),
      { kind: 'user', userId: 'admin-1', roles: ['registry-manager'] },
    );
    expect(context.action.params.values).toEqual(
      expect.objectContaining({
        providerConfig: { repositoryId: 42, ref: 'release', rootPath: 'skills' },
        providerAccessAuthorizedById: 'admin-1',
        providerAccessAuthorizedAt: expect.any(Date),
      }),
    );
    expect(next).toHaveBeenCalledOnce();
  });
});
