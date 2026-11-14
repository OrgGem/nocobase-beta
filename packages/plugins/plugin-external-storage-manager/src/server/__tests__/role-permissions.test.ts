// SPDX-License-Identifier: Apache-2.0

import { ACL } from '@nocobase/acl';
import { vi } from 'vitest';
import { createExtStorageActions } from '../actions/ext-storage';
import type { IStorageAdapter } from '../adapters/types';

type PermissionAction = 'view' | 'update' | 'destroy';

function makeRecord(values: Record<string, unknown>) {
  return {
    ...values,
    get(key: string) {
      return values[key];
    },
    toJSON() {
      return values;
    },
    writeToACL: vi.fn().mockResolvedValue(undefined),
  };
}

function makeAction(name: PermissionAction, scopeId: number, scope: unknown) {
  const values = { name, scopeId };
  return {
    get(key: string) {
      return values[key as keyof typeof values];
    },
    toJSON() {
      return { ...values, scope: { id: scopeId, scope } };
    },
    update: vi.fn().mockResolvedValue(undefined),
  };
}

function makeHarness(
  options: {
    resource?: ReturnType<typeof makeRecord> | null;
    legacyResource?: ReturnType<typeof makeRecord> | null;
    actions?: ReturnType<typeof makeAction>[];
    values?: Partial<Record<PermissionAction, Array<string | number>>>;
    roleName?: string;
    acl?: ACL;
    failActionUpdate?: boolean;
    dataSourceRole?: ReturnType<typeof makeRecord> | null;
  } = {},
) {
  const transaction = { id: 'test-transaction' };
  const commit = vi.fn();
  const rollback = vi.fn();
  const transactionRun = vi.fn(async (callback: (transaction: typeof transaction) => Promise<unknown>) => {
    try {
      const result = await callback(transaction);
      commit();
      return result;
    } catch (error) {
      rollback();
      throw error;
    }
  });
  const modernResource = options.resource ?? null;
  const legacyResource = options.legacyResource ?? null;
  const scopeCreate = vi
    .fn()
    .mockImplementation(async ({ values }: { values: Record<string, unknown> }) => makeRecord({ ...values, id: 900 }));
  const scopeUpdate = vi.fn();
  const actionCreate = vi.fn().mockResolvedValue(undefined);
  const resourceCreate = vi
    .fn()
    .mockImplementation(async ({ values }: { values: Record<string, unknown> }) => makeRecord({ ...values, id: 500 }));
  const modernResourceRepo = {
    findOne: vi.fn().mockResolvedValue(modernResource),
    create: resourceCreate,
  };
  const legacyResourceRepo = {
    findOne: vi.fn().mockResolvedValue(legacyResource),
  };
  const actionsRepo = {
    find: vi.fn().mockResolvedValue(options.actions ?? []),
    create: actionCreate,
  };
  const scopesRepo = { create: scopeCreate, update: scopeUpdate };
  const rolesRepo = { findOne: vi.fn().mockResolvedValue({ name: options.roleName ?? 'reader' }) };
  const roleRecord = makeRecord({ name: options.roleName ?? 'reader', strategy: { actions: ['view'] } });
  rolesRepo.findOne.mockResolvedValue(roleRecord);
  const dataSourceRoleRepo = {
    findOne: vi.fn().mockResolvedValue(options.dataSourceRole ?? null),
    create: vi.fn().mockResolvedValue(undefined),
  };
  const repositories: Record<string, unknown> = {
    dataSourcesRoles: dataSourceRoleRepo,
    dataSourcesRolesResources: modernResourceRepo,
    dataSourcesRolesResourcesActions: actionsRepo,
    dataSourcesRolesResourcesScopes: scopesRepo,
    rolesResources: legacyResourceRepo,
    roles: rolesRepo,
  };
  const acl = options.acl ?? new ACL();
  const syncRoleResource = vi.fn().mockResolvedValue(undefined);
  const app = {
    acl,
    snowflakeIdGenerator: { generate: vi.fn(() => 500) },
    pm: { get: vi.fn(() => ({ sendSyncMessage: syncRoleResource })) },
  };
  const thrown: Array<{ status: number; message: string }> = [];
  const values = options.values ?? { view: [9] };
  const roleName = options.roleName ?? 'reader';
  const ctx = {
    action: {
      params: {
        roleName,
        values: { roleName, values },
      },
    },
    request: { body: {} },
    state: { currentRoles: ['root'], currentRole: 'root' },
    app,
    t: (key: string) => key,
    db: {
      getRepository: vi.fn((name: string) => repositories[name]),
      sequelize: { transaction: transactionRun },
    },
    logger: { warn: vi.fn(), error: vi.fn() },
    throw(status: number, message: string) {
      thrown.push({ status, message });
      const error = new Error(message) as Error & { status: number };
      error.status = status;
      throw error;
    },
    body: undefined as unknown,
  };
  const adapter = {} as IStorageAdapter;
  const actions = createExtStorageActions(async () => adapter);
  return {
    actions,
    ctx,
    app,
    acl,
    transaction,
    transactionRun,
    commit,
    rollback,
    thrown,
    resourceCreate,
    modernResourceRepo,
    legacyResourceRepo,
    actionsRepo,
    actionCreate,
    scopeCreate,
    scopeUpdate,
    rolesRepo,
    roleRecord,
    dataSourceRoleRepo,
    syncRoleResource,
  };
}

describe('external storage role permission actions', () => {
  it('returns exact managed IDs and read-only metadata from the current ACL repositories', async () => {
    const resource = makeRecord({
      id: 21,
      roleName: 'reader',
      dataSourceKey: 'main',
      name: 'externalStorageDirectories',
    });
    const view = makeAction('view', 101, { $and: [{ id: { $in: [1, '2'] } }] });
    const update = makeAction('update', 102, { id: { $in: [3], enabled: true } });
    const harness = makeHarness({ resource, actions: [view, update] });
    harness.ctx.action.params = { roleName: 'reader' };

    await harness.actions.rolePermissions(harness.ctx);

    expect(harness.ctx.body).toEqual({ view: [1, '2'], update: [], destroy: [], readOnlyActions: ['update'] });
    expect(harness.ctx.db.getRepository).toHaveBeenCalledWith('dataSourcesRolesResources');
    expect(harness.modernResourceRepo.findOne).toHaveBeenCalledWith({
      filter: { roleName: 'reader', dataSourceKey: 'main', name: 'externalStorageDirectories' },
    });
    expect(harness.ctx.db.getRepository).toHaveBeenCalledWith('dataSourcesRolesResourcesActions');
  });

  it('marks legacy-only and inherited directory grants read-only without exposing guessed IDs', async () => {
    const acl = new ACL();
    acl.define({
      role: 'inherited',
      actions: { 'externalStorageDirectories:view': {}, 'externalStorageDirectories:update': {} },
    });
    const legacyResource = makeRecord({ id: 7, roleName: 'reader', name: 'externalStorageDirectories' });
    const legacy = makeHarness({ legacyResource });
    legacy.ctx.action.params = { roleName: 'reader' };

    await legacy.actions.rolePermissions(legacy.ctx);
    expect(legacy.ctx.body).toEqual({
      view: [],
      update: [],
      destroy: [],
      readOnlyActions: ['view', 'update', 'destroy'],
    });
    expect(legacy.legacyResourceRepo.findOne).toHaveBeenCalledWith({
      filter: { roleName: 'reader', name: 'externalStorageDirectories' },
    });

    const inherited = makeHarness({ acl, roleName: 'inherited' });
    inherited.ctx.action.params = { roleName: 'inherited' };
    await inherited.actions.rolePermissions(inherited.ctx);
    expect(inherited.ctx.body).toEqual({
      view: [],
      update: [],
      destroy: [],
      readOnlyActions: ['view', 'update', 'destroy'],
    });
  });

  it('keeps root and strategy-managed resource permissions read-only', async () => {
    const root = makeHarness();
    root.ctx.action.params = { roleName: 'root' };
    await root.actions.rolePermissions(root.ctx);
    expect(root.ctx.body).toEqual({
      view: [],
      update: [],
      destroy: [],
      readOnlyActions: ['view', 'update', 'destroy'],
    });
    expect(root.ctx.db.getRepository).not.toHaveBeenCalled();

    const strategyResource = makeRecord({
      id: 21,
      roleName: 'reader',
      dataSourceKey: 'main',
      name: 'externalStorageDirectories',
      usingActionsConfig: false,
    });
    const strategy = makeHarness({ resource: strategyResource });
    strategy.ctx.action.params = { roleName: 'reader' };
    await strategy.actions.rolePermissions(strategy.ctx);
    expect(strategy.ctx.body).toEqual({
      view: [],
      update: [],
      destroy: [],
      readOnlyActions: ['view', 'update', 'destroy'],
    });
    expect(strategy.actionsRepo.find).not.toHaveBeenCalled();
  });

  it('rejects edits to inherited or legacy permissions before creating modern ACL rows', async () => {
    const acl = new ACL();
    acl.define({ role: 'inherited', actions: { 'externalStorageDirectories:view': {} } });
    const harness = makeHarness({ acl, roleName: 'inherited', legacyResource: null });

    await expect(harness.actions.updateRolePermissions(harness.ctx)).rejects.toMatchObject({ status: 409 });
    expect(harness.resourceCreate).not.toHaveBeenCalled();
    expect(harness.scopeCreate).not.toHaveBeenCalled();
    expect(harness.actionCreate).not.toHaveBeenCalled();
  });

  it('rejects root permission edits before creating ACL rows', async () => {
    const harness = makeHarness({ roleName: 'root' });

    await expect(harness.actions.updateRolePermissions(harness.ctx)).rejects.toMatchObject({ status: 409 });
    expect(harness.resourceCreate).not.toHaveBeenCalled();
    expect(harness.dataSourceRoleRepo.create).not.toHaveBeenCalled();
    expect(harness.scopeCreate).not.toHaveBeenCalled();
  });

  it('updates only the supplied action using a new scope when action scopes are shared', async () => {
    const resource = makeRecord({ id: 21, roleName: 'reader', usingActionsConfig: true });
    const sharedScope = { id: { $in: [1] } };
    const view = makeAction('view', 101, sharedScope);
    const update = makeAction('update', 101, sharedScope);
    const harness = makeHarness({ resource, actions: [view, update], values: { view: [2] } });

    await harness.actions.updateRolePermissions(harness.ctx);

    expect(harness.scopeCreate).toHaveBeenCalledWith({
      values: {
        dataSourceKey: 'main',
        resourceName: 'externalStorageDirectories',
        scope: { $and: [{ id: { $in: [2] } }] },
      },
      transaction: harness.transaction,
    });
    expect(view.update).toHaveBeenCalledWith({ scopeId: 900 }, { transaction: harness.transaction, hooks: false });
    expect(update.update).not.toHaveBeenCalled();
    expect(harness.scopeUpdate).not.toHaveBeenCalled();
    expect(harness.transactionRun).toHaveBeenCalledTimes(1);
    expect(harness.commit).toHaveBeenCalledTimes(1);
    expect(harness.syncRoleResource).toHaveBeenCalledWith({
      type: 'syncRoleResource',
      roleName: 'reader',
      dataSourceKey: 'main',
      resourceName: 'externalStorageDirectories',
    });
  });

  it('creates the modern data-source role parent with the existing role strategy', async () => {
    const harness = makeHarness({ values: { view: [9] } });

    await harness.actions.updateRolePermissions(harness.ctx);

    expect(harness.dataSourceRoleRepo.findOne).toHaveBeenCalledWith({
      filter: { roleName: 'reader', dataSourceKey: 'main' },
      transaction: harness.transaction,
      lock: true,
    });
    expect(harness.dataSourceRoleRepo.create).toHaveBeenCalledWith({
      values: expect.objectContaining({ roleName: 'reader', dataSourceKey: 'main', strategy: { actions: ['view'] } }),
      transaction: harness.transaction,
      hooks: false,
    });
    expect(harness.resourceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        values: expect.objectContaining({ roleName: 'reader', dataSourceKey: 'main', usingActionsConfig: true }),
        transaction: harness.transaction,
        hooks: false,
      }),
    );
  });

  it('leaves an existing data-source role strategy untouched when writing plugin scopes', async () => {
    const existingDataSourceRole = makeRecord({
      roleName: 'reader',
      dataSourceKey: 'main',
      strategy: { actions: ['view', 'update'] },
    });
    const harness = makeHarness({ dataSourceRole: existingDataSourceRole, values: { view: [9] } });

    await harness.actions.updateRolePermissions(harness.ctx);

    expect(harness.dataSourceRoleRepo.create).not.toHaveBeenCalled();
    expect(existingDataSourceRole.get('strategy')).toEqual({ actions: ['view', 'update'] });
  });

  it('rejects an advanced scope before touching action or scope records', async () => {
    const resource = makeRecord({ id: 21, roleName: 'reader', usingActionsConfig: true });
    const view = makeAction('view', 101, { $and: [{ id: { $in: [1] } }, { enabled: true }] });
    const harness = makeHarness({ resource, actions: [view], values: { view: [] } });

    await expect(harness.actions.updateRolePermissions(harness.ctx)).rejects.toMatchObject({ status: 409 });
    expect(view.update).not.toHaveBeenCalled();
    expect(harness.scopeCreate).not.toHaveBeenCalled();
    expect(harness.commit).not.toHaveBeenCalled();
    expect(harness.rollback).toHaveBeenCalledTimes(1);
    expect(harness.syncRoleResource).not.toHaveBeenCalled();
  });

  it('passes writes through the transaction and propagates failures for rollback', async () => {
    const resource = makeRecord({ id: 21, roleName: 'reader', usingActionsConfig: true });
    const view = makeAction('view', 101, { id: { $in: [1] } });
    view.update.mockRejectedValueOnce(new Error('write failed'));
    const harness = makeHarness({ resource, actions: [view], values: { view: [2] } });

    await expect(harness.actions.updateRolePermissions(harness.ctx)).rejects.toThrow('write failed');
    expect(harness.scopeCreate).toHaveBeenCalledWith(expect.objectContaining({ transaction: harness.transaction }));
    expect(harness.rollback).toHaveBeenCalledTimes(1);
    expect(harness.commit).not.toHaveBeenCalled();
    expect(harness.syncRoleResource).not.toHaveBeenCalled();
  });
});
