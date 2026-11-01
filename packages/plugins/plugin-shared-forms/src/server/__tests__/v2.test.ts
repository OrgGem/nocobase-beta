/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { ACL } from '@nocobase/acl';
import type { Application } from '@nocobase/server';
import { describe, expect, it, vi } from 'vitest';
import PluginSharedForms from '../plugin';

function fixture(
  options: {
    enabled?: boolean;
    grant?: boolean;
    allowedRoles?: string[];
    userRoles?: string[];
    legacy?: boolean;
    config?: boolean;
  } = {},
) {
  const config = {
    version: 2,
    successMessage: 'Done',
    model: {
      use: 'SharedFormModel',
      stepParams: { resourceSettings: { init: { dataSourceKey: 'crm', collectionName: 'orders' } } },
      subModels: {
        grid: {
          use: 'FormGridModel',
          subModels: {
            items: [
              {
                use: 'FormItemModel',
                stepParams: {
                  fieldSettings: { init: { dataSourceKey: 'crm', collectionName: 'orders', fieldPath: 'title' } },
                },
              },
            ],
          },
        },
      },
    },
  };
  const values = {
    key: 'form',
    enabled: options.enabled ?? true,
    collection: 'crm:orders',
    title: 'Orders',
    v2Config: options.config === false ? null : config,
  };
  const row = { get: (key: keyof typeof values) => values[key] };
  const collection = {
    name: 'orders',
    options: {},
    filterTargetKey: 'orderCode',
    titleField: 'title',
    getFields: () => [{ options: { name: 'title', type: 'string', interface: 'input' } }],
    getField: (name: string) => ({
      options:
        name === 'customer'
          ? { type: 'belongsTo', target: 'customers' }
          : name === 'attachment'
            ? { type: 'belongsToMany', target: 'attachments' }
            : { type: 'string' },
    }),
  };
  const targetCollection = (name: string) =>
    name === 'orders'
      ? collection
      : { ...collection, name, options: name === 'attachments' ? { template: 'file' } : {} };
  const findOne = vi.fn(async () => row);
  const repositories = {
    sharedForms: { findOne, collection: { name: 'sharedForms' } },
    sharedFormsRoles: { find: vi.fn(async () => (options.allowedRoles || []).map((role) => ({ get: () => role }))) },
    rolesUsers: { find: vi.fn(async () => (options.userRoles || ['member']).map((role) => ({ get: () => role }))) },
    uiSchemas: { getJsonSchema: vi.fn(async () => (options.legacy ? { properties: { form: {} } } : null)) },
  };
  const db = {
    getRepository: (name: keyof typeof repositories) => repositories[name],
    getCollection: () => collection,
  };
  const acl = new ACL();
  acl.setAvailableAction('view', { type: 'old-data' });
  for (const role of ['member', 'root'])
    acl.define({ role, actions: options.grant === false ? {} : { 'sharedForms:view': {} } });
  const dataSources = new Map([
    ['main', { collectionManager: { getRepository: () => repositories.sharedForms, getCollection: () => collection } }],
    ['crm', { collectionManager: { getCollection: targetCollection } }],
  ]);
  const app = { db, acl, dataSourceManager: { dataSources } } as unknown as Application;
  const plugin = new PluginSharedForms(app, { name: 'shared-forms' });
  const headers: Record<string, string> = {
    'X-Shared-Form-Key': 'form',
    'X-Shared-Form-Version': '2',
    'X-Data-Source': 'crm',
  };
  const ctx = {
    action: {
      actionName: 'sharedSubmit',
      resourceName: 'orders',
      params: { values: { title: 'Hello' }, updateAssociationValues: ['*'], filterByTk: 'form' },
    },
    state: { currentUser: { id: '90071992547409933' }, currentRoles: options.userRoles || ['member'] },
    get: (key: string) => headers[key] || '',
    db,
    throw: (status: number, message: string): never => {
      throw Object.assign(new Error(message), { status });
    },
    SharedForm: undefined as { collectionName: string } | undefined,
    body: undefined as unknown,
  };
  return { plugin, ctx, headers, acl, findOne, config };
}
describe('Shared Forms V2 server with actual ACL and repository stubs', () => {
  it('routes authorized submissions through native create and enforces the configured whitelist', async () => {
    const { plugin, ctx } = fixture();
    const next = vi.fn();
    await plugin.sharedFormMiddleware(ctx, next);
    expect(ctx.action.actionName).toBe('create');
    expect(ctx.action.params).toMatchObject({ whitelist: ['title'], updateAssociationValues: [] });
    expect(ctx.SharedForm?.collectionName).toBe('orders');
    expect(next).toHaveBeenCalledTimes(1);
  });
  it('requires authentication and an enabled form', async () => {
    const anonymous = fixture();
    anonymous.ctx.state.currentUser = null;
    await expect(anonymous.plugin.sharedFormMiddleware(anonymous.ctx, vi.fn())).rejects.toMatchObject({ status: 401 });
    const disabled = fixture({ enabled: false });
    await expect(disabled.plugin.sharedFormMiddleware(disabled.ctx, vi.fn())).rejects.toMatchObject({ status: 403 });
  });
  it('checks both role-level view permission and the form allowed-role list', async () => {
    const denied = fixture({ grant: false });
    await expect(denied.plugin.sharedFormMiddleware(denied.ctx, vi.fn())).rejects.toThrow('No permissions');
    const restricted = fixture({ allowedRoles: ['finance'] });
    await expect(restricted.plugin.sharedFormMiddleware(restricted.ctx, vi.fn())).rejects.toMatchObject({
      status: 403,
    });
    const root = fixture({ userRoles: ['root'], allowedRoles: ['finance'] });
    await root.plugin.sharedFormMiddleware(root.ctx, vi.fn());
    expect(root.ctx.action.actionName).toBe('create');
  });
  it('rejects use of the key against another resource or datasource', async () => {
    const wrongResource = fixture();
    wrongResource.ctx.action.resourceName = 'users';
    await expect(wrongResource.plugin.sharedFormMiddleware(wrongResource.ctx, vi.fn())).rejects.toMatchObject({
      status: 403,
    });
    const wrongSource = fixture();
    wrongSource.headers['X-Data-Source'] = 'main';
    await expect(wrongSource.plugin.sharedFormMiddleware(wrongSource.ctx, vi.fn())).rejects.toMatchObject({
      status: 403,
    });
  });
  it('rejects extra fields and cannot bypass V2-only restrictions by omitting the version header', async () => {
    const { plugin, ctx, headers } = fixture();
    delete headers['X-Shared-Form-Version'];
    Object.assign(ctx.action.params.values, { password: 'unexpected' });
    await expect(plugin.sharedFormMiddleware(ctx, vi.fn())).rejects.toMatchObject({ status: 400 });
  });
  it('keeps the legacy submission path when a V1 schema exists and rejects invalid V2 configurations', async () => {
    const legacy = fixture({ legacy: true, config: false });
    delete legacy.headers['X-Shared-Form-Version'];
    await legacy.plugin.sharedFormMiddleware(legacy.ctx, vi.fn());
    expect(legacy.ctx.action.actionName).toBe('create');
    const invalid = fixture({ config: false });
    await expect(invalid.plugin.sharedFormMiddleware(invalid.ctx, vi.fn())).rejects.toMatchObject({ status: 400 });
  });
  it('returns a V2 snapshot/metadata after role checks and no form data for a disabled form', async () => {
    const { plugin, ctx } = fixture();
    await plugin.getV2Meta(ctx, vi.fn());
    expect(ctx.body).toMatchObject({
      key: 'form',
      collection: 'crm:orders',
      config: { version: 2 },
      dataSource: {
        key: 'crm',
        collections: [expect.objectContaining({ filterTargetKey: 'orderCode', titleField: 'title' })],
      },
    });
    const disabled = fixture({ enabled: false });
    await disabled.plugin.getV2Meta(disabled.ctx, vi.fn());
    expect(disabled.ctx.body).toBeNull();
  });
  it('grants configured relation reads and file uploads after checking the form permission, without granting arbitrary create', async () => {
    const { plugin, ctx, config } = fixture();
    config.model.subModels.grid.subModels.items.push({
      use: 'FormItemModel',
      stepParams: {
        fieldSettings: { init: { dataSourceKey: 'crm', collectionName: 'orders', fieldPath: 'customer' } },
      },
    });
    config.model.subModels.grid.subModels.items.push({
      use: 'FormItemModel',
      stepParams: {
        fieldSettings: { init: { dataSourceKey: 'crm', collectionName: 'orders', fieldPath: 'attachment' } },
      },
    });
    ctx.action.actionName = 'list';
    ctx.action.resourceName = 'customers';
    await plugin.sharedFormMiddleware(ctx, vi.fn());
    expect(ctx.SharedForm).toMatchObject({ targetCollections: ['customers', 'attachments'] });
    ctx.SharedForm = undefined;
    ctx.action.actionName = 'upload';
    ctx.action.resourceName = 'attachments';
    await plugin.sharedFormMiddleware(ctx, vi.fn());
    expect(ctx.SharedForm).toBeDefined();
    ctx.SharedForm = undefined;
    ctx.action.actionName = 'create';
    ctx.action.resourceName = 'orders';
    await plugin.sharedFormMiddleware(ctx, vi.fn());
    expect(ctx.SharedForm).toBeUndefined();
    ctx.action.actionName = 'list';
    ctx.action.resourceName = 'customers';
    const denied = fixture({ grant: false });
    denied.ctx.action.actionName = 'list';
    denied.ctx.action.resourceName = 'customers';
    await expect(denied.plugin.sharedFormMiddleware(denied.ctx, vi.fn())).rejects.toThrow('No permissions');
  });
});
