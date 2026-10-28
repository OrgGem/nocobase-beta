/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockServer, type MockServer } from '@nocobase/test';
import RouterPlugin from '../plugin';
import aliasCollection from '../collections/desktop-route-path-aliases';

class TestRouterPlugin extends RouterPlugin {
  async loadCollections() {
    this.db.collection(aliasCollection);
  }
}

describe('friendly aliases with ACL and UI Layout', () => {
  let app: MockServer;
  let storage: string;
  const previousStorage = process.env.STORAGE_PATH;

  beforeAll(async () => {
    storage = mkdtempSync(join(tmpdir(), 'nocobase-router-alias-test-'));
    process.env.STORAGE_PATH = storage;
    app = await createMockServer({
      registerActions: true,
      acl: true,
      plugins: [
        'error-handler',
        'users',
        'auth',
        'client',
        'field-sort',
        'acl',
        'ui-schema-storage',
        'system-settings',
        'data-source-main',
        'data-source-manager',
        'ui-layout',
        [TestRouterPlugin, { name: 'router-configuration' }],
      ],
    });
  }, 300000);

  afterAll(async () => {
    await app?.destroy();
    if (previousStorage === undefined) delete process.env.STORAGE_PATH;
    else process.env.STORAGE_PATH = previousStorage;
    if (storage) rmSync(storage, { recursive: true, force: true });
  });

  it('limits alias writes and exposes only authoritative aliases on accessible routes', async () => {
    const routes = app.db.getRepository('desktopRoutes');
    const first = await routes.create({
      values: {
        type: 'flowPage',
        title: 'Allowed alias route',
        schemaUid: 'allowed-uid',
        uiLayouts: ['admin-layout-model'],
      },
    });
    const second = await routes.create({
      values: {
        type: 'flowPage',
        title: 'Denied alias route',
        schemaUid: 'denied-uid',
        uiLayouts: ['admin-layout-model'],
      },
    });
    const forged = await routes.create({
      values: {
        type: 'flowPage',
        title: 'Forged alias route',
        schemaUid: 'forged-uid',
        options: { pathAlias: 'settings', keep: 'unchanged' },
        uiLayouts: ['admin-layout-model'],
      },
    });
    const root = await app.db.getRepository('users').findOne({ filter: { 'roles.name': 'root' } });
    const rootAgent = await app.agent().login(root);
    for (const [route, slug] of [
      [first, 'allowed-alias'],
      [second, 'denied-alias'],
    ] as const) {
      const response = await rootAgent
        .post('/desktopRoutes:setPathAlias')
        .send({ values: { id: route.get('id'), pathAlias: slug } });
      expect(response.status).toBe(200);
    }
    await rootAgent.resource('roles.desktopRoutes', 'member').remove({ values: [second.get('id')] });
    await rootAgent.resource('roles.desktopRoutes', 'member').add({ values: [first.get('id'), forged.get('id')] });
    const member = await app.db.getRepository('users').create({ values: { roles: ['member'] } });
    const memberAgent = await app.agent().login(member);
    const deniedWrite = await memberAgent
      .post('/desktopRoutes:setPathAlias')
      .send({ values: { id: first.get('id'), pathAlias: 'member-write' } });
    expect(deniedWrite.status).toBe(403);
    const response = await memberAgent
      .get('/desktopRoutes:listAccessible')
      .query({ tree: true, layout: 'admin-layout-model' });
    expect(response.status).toBe(200);
    const flatten = (items: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
      items.flatMap((item) => [item, ...flatten((item.children || []) as Array<Record<string, unknown>>)]);
    const visible = flatten(response.body.data);
    expect(visible.find((item) => item.schemaUid === 'allowed-uid')).toMatchObject({
      options: { pathAlias: 'allowed-alias' },
    });
    expect(visible.find((item) => item.schemaUid === 'denied-uid')).toBeUndefined();
    const forgedRoute = visible.find((item) => item.schemaUid === 'forged-uid');
    expect(forgedRoute).toMatchObject({ options: { keep: 'unchanged' } });
    expect((forgedRoute?.options as Record<string, unknown>).pathAlias).toBeUndefined();

    await routes.update({ filterByTk: first.get('id'), values: { type: 'page' } });
    const removeStale = await rootAgent
      .post('/desktopRoutes:setPathAlias')
      .send({ values: { id: first.get('id'), pathAlias: null } });
    expect(removeStale.status).toBe(200);
    expect(
      await app.db.getRepository('desktopRoutePathAliases').findOne({ filter: { desktopRouteId: first.get('id') } }),
    ).toBeNull();
    await routes.destroy({ filterByTk: second.get('id') });
    expect(
      await app.db.getRepository('desktopRoutePathAliases').findOne({ filter: { desktopRouteId: second.get('id') } }),
    ).toBeNull();
  }, 300000);
});
