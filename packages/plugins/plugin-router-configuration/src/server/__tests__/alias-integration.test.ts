// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockServer, type MockServer } from '@nocobase/test';
import RouterPlugin from '../plugin';
import aliasCollection from '../collections/desktop-route-path-aliases';
import { repairAllLegacyRouteContents } from '../route-content-repair';
import FlowModelRepository from '../../../../@nocobase/plugin-flow-engine/src/server/repository';

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
        'flow-engine',
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

  it('repairs a detached legacy V2 page when saving its canonical path or changing its alias', async () => {
    const routes = app.db.getRepository('desktopRoutes');
    const flowModels = app.db.getRepository('flowModels') as FlowModelRepository;
    const routeUid = 'vpb-home';
    const pageUid = 'legacy-root-page';
    const route = await routes.create({
      values: {
        type: 'flowPage',
        title: 'Legacy V2 page',
        schemaUid: routeUid,
        uiLayouts: ['admin-layout-model'],
      },
    });
    const routeId = route.get('id') as string | number;

    await flowModels.remove(routeUid);
    await flowModels.model.bulkCreate(
      Array.from({ length: 505 }, (_, index) => ({
        uid: `legacy-filler-${String(index).padStart(4, '0')}`,
        name: `legacy-filler-${index}`,
        options: { use: 'UnusedModel' },
      })),
    );
    await flowModels.upsertModel({
      uid: pageUid,
      use: 'RootPageModel',
      props: { routeId: String(routeId), title: 'Existing page' },
    });
    const pageModel = await flowModels.model.findByPk(pageUid);
    expect(pageModel).not.toBeNull();
    if (!pageModel) {
      throw new Error('Expected the detached legacy page model to exist.');
    }
    const pageOptions = pageModel.get('options');
    await pageModel.update({ options: JSON.stringify(pageOptions) }, { hooks: false });
    expect(typeof pageModel.get('options')).toBe('string');

    const tabModels: Array<{ routeUid: string; gridUid: string; blockUid: string }> = [];
    for (let index = 0; index < 5; index++) {
      const tabUid = `legacy-tab-${index}`;
      const gridUid = `legacy-grid-${index}`;
      const blockUid = `legacy-block-${index}`;
      const tab = await routes.create({
        values: {
          type: 'tabs',
          title: `Existing tab ${index}`,
          schemaUid: tabUid,
          parentId: routeId,
        },
      });
      expect(tab.get('schemaUid')).toBe(tabUid);
      await flowModels.ensureRouteContent({
        uid: gridUid,
        parentId: tabUid,
        subKey: 'grid',
        use: 'BlockGridModel',
      });
      await flowModels.upsertModel({
        uid: blockUid,
        parentId: gridUid,
        subKey: 'items',
        subType: 'array',
        use: 'TableBlockModel',
      });
      tabModels.push({ routeUid: tabUid, gridUid, blockUid });
    }

    const treePaths = app.db.getRepository('flowModelTreePath');
    await treePaths.destroy({ filter: { ancestor: pageUid, descendant: pageUid, depth: 0 } });
    expect(await flowModels.model.findByPk(routeUid)).toBeNull();
    expect(await flowModels.model.findByPk(pageUid)).not.toBeNull();
    expect(await flowModels.findModelNodeSnapshotById(pageUid)).toBeNull();

    const root = await app.db.getRepository('users').findOne({ filter: { 'roles.name': 'root' } });
    const rootAgent = await app.agent().login(root);
    const saveCanonicalPath = async () =>
      rootAgent.post('/desktopRoutes:setPathAlias').send({
        values: { id: route.get('id'), pathAlias: routeUid },
      });

    const canonicalSave = await saveCanonicalPath();
    expect(canonicalSave.status).toBe(200);
    const repaired = await flowModels.findModelNodeSnapshotById(pageUid);
    expect(repaired).toMatchObject({ uid: pageUid, parentId: routeUid, subKey: 'page', async: true });
    expect(
      await flowModels.ensureRouteContent({
        parentId: routeUid,
        subKey: 'page',
        use: 'RootPageModel',
        uid: 'new-page-that-must-not-replace-existing',
      }),
    ).toBe(pageUid);

    const changedAlias = await rootAgent.post('/desktopRoutes:setPathAlias').send({
      values: { id: route.get('id'), pathAlias: 'home-friendly' },
    });
    expect(changedAlias.status).toBe(200);
    const repeatedAlias = await rootAgent.post('/desktopRoutes:setPathAlias').send({
      values: { id: route.get('id'), pathAlias: 'home-friendly' },
    });
    expect(repeatedAlias.status).toBe(200);

    const canonicalReset = await saveCanonicalPath();
    expect(canonicalReset.status).toBe(200);

    const aliasRow = await app.db
      .getRepository('desktopRoutePathAliases')
      .findOne({ filter: { desktopRouteId: route.get('id') } });
    expect(aliasRow).toBeNull();
    expect(await flowModels.findModelById(routeUid, { includeAsyncNode: true })).toMatchObject({
      uid: routeUid,
      use: 'RouteModel',
      subModels: { page: { uid: pageUid } },
    });
    for (const { routeUid: tabUid, gridUid, blockUid } of tabModels) {
      const grid = await flowModels.findModelByParentId(tabUid, { subKey: 'grid', includeAsyncNode: true });
      expect(grid).toMatchObject({
        uid: gridUid,
        subModels: { items: [{ uid: blockUid }] },
      });
    }
  }, 300000);

  it('selects the best detached page when multiple legacy pages claim the same route', async () => {
    const routes = app.db.getRepository('desktopRoutes');
    const flowModels = app.db.getRepository('flowModels') as FlowModelRepository;
    const routeUid = 'vpb-ambiguous';
    const route = await routes.create({
      values: {
        type: 'flowPage',
        title: 'Ambiguous legacy V2 page',
        schemaUid: routeUid,
        uiLayouts: ['admin-layout-model'],
      },
    });
    const routeId = String(route.get('id'));
    await flowModels.remove(routeUid);
    await flowModels.upsertModel({
      uid: 'ambiguous-page-a',
      use: 'RootPageModel',
      props: { routeId },
    });
    await flowModels.upsertModel({
      uid: 'ambiguous-page-b',
      use: 'RootPageModel',
      props: { routeId, enableTabs: true },
      stepParams: { pageSettings: { general: { displayTitle: true } } },
    });

    const root = await app.db.getRepository('users').findOne({ filter: { 'roles.name': 'root' } });
    const rootAgent = await app.agent().login(root);
    const response = await rootAgent.post('/desktopRoutes:setPathAlias').send({
      values: { id: route.get('id'), pathAlias: 'ambiguous-friendly' },
    });

    expect(response.status).toBe(200);
    expect(await flowModels.findModelNodeSnapshotById('ambiguous-page-b')).toMatchObject({
      uid: 'ambiguous-page-b',
      parentId: routeUid,
      subKey: 'page',
      async: true,
    });
    expect(await flowModels.findModelNodeSnapshotById('ambiguous-page-a')).toMatchObject({
      parentId: null,
      subKey: null,
    });
    expect(
      await flowModels.ensureRouteContent({
        parentId: routeUid,
        subKey: 'page',
        use: 'RootPageModel',
        uid: 'must-not-create-third-page',
      }),
    ).toBe('ambiguous-page-b');
  }, 300000);

  it('rejects recovery when the matching page still belongs to another live route and rolls back the alias', async () => {
    const routes = app.db.getRepository('desktopRoutes');
    const flowModels = app.db.getRepository('flowModels') as FlowModelRepository;
    const liveOwnerUid = 'vpb-live-owner';
    const brokenRouteUid = 'vpb-conflicting-claim';
    const liveOwner = await routes.create({
      values: {
        type: 'flowPage',
        title: 'Live owner V2 page',
        schemaUid: liveOwnerUid,
        uiLayouts: ['admin-layout-model'],
      },
    });
    expect(liveOwner.get('schemaUid')).toBe(liveOwnerUid);
    const brokenRoute = await routes.create({
      values: {
        type: 'flowPage',
        title: 'Broken claiming V2 page',
        schemaUid: brokenRouteUid,
        uiLayouts: ['admin-layout-model'],
      },
    });
    await flowModels.remove(brokenRouteUid);
    await flowModels.upsertModel({
      uid: 'shared-live-root-page',
      parentId: liveOwnerUid,
      subKey: 'page',
      subType: 'object',
      async: true,
      use: 'RootPageModel',
      props: { routeId: String(brokenRoute.get('id')) },
    });

    const root = await app.db.getRepository('users').findOne({ filter: { 'roles.name': 'root' } });
    const rootAgent = await app.agent().login(root);
    const response = await rootAgent.post('/desktopRoutes:setPathAlias').send({
      values: { id: brokenRoute.get('id'), pathAlias: 'conflicting-friendly' },
    });

    expect(response.status).toBe(409);
    expect(await flowModels.model.findByPk(brokenRouteUid)).toBeNull();
    expect(
      await app.db
        .getRepository('desktopRoutePathAliases')
        .findOne({ filter: { desktopRouteId: brokenRoute.get('id') } }),
    ).toBeNull();
    expect(await flowModels.findModelNodeSnapshotById('shared-live-root-page')).toMatchObject({
      parentId: liveOwnerUid,
      subKey: 'page',
    });
  }, 300000);

  it('recreates missing RouteModel anchors for legacy pages without a persisted RootPageModel and broken child tabs', async () => {
    const routes = app.db.getRepository('desktopRoutes');
    const flowModels = app.db.getRepository('flowModels') as FlowModelRepository;
    const treePaths = app.db.getRepository('flowModelTreePath');
    const routeUid = 'vpb-no-root-page';
    const emptyTabUid = 'vpb-empty-tab';
    const contentTabUid = 'vpb-content-tab';
    const detachedGridUid = 'detached-tab-grid';
    const detachedBlockUid = 'detached-tab-block';

    const route = await routes.create({
      values: {
        type: 'flowPage',
        title: 'Legacy page without persisted RootPageModel',
        schemaUid: routeUid,
        uiLayouts: ['admin-layout-model'],
      },
    });
    const routeId = route.get('id') as string | number;
    await routes.create({
      values: {
        type: 'tabs',
        title: 'Empty tab',
        schemaUid: emptyTabUid,
        parentId: routeId,
      },
    });
    await routes.create({
      values: {
        type: 'tabs',
        title: 'Tab with detached grid',
        schemaUid: contentTabUid,
        parentId: routeId,
      },
    });

    await flowModels.ensureRouteContent({
      uid: detachedGridUid,
      parentId: contentTabUid,
      subKey: 'grid',
      use: 'BlockGridModel',
    });
    await flowModels.upsertModel({
      uid: detachedBlockUid,
      parentId: detachedGridUid,
      subKey: 'items',
      subType: 'array',
      use: 'TableBlockModel',
    });

    // Simulate missing RouteModels on the page and both child tabs while keeping the tab grid and block rows.
    await flowModels.remove(routeUid);
    await flowModels.remove(emptyTabUid);
    await treePaths.destroy({ filter: { ancestor: contentTabUid } });
    await flowModels.model.destroy({ where: { uid: contentTabUid }, hooks: false });

    const root = await app.db.getRepository('users').findOne({ filter: { 'roles.name': 'root' } });
    const rootAgent = await app.agent().login(root);
    const response = await rootAgent.post('/desktopRoutes:setPathAlias').send({
      values: { id: routeId, pathAlias: null },
    });

    expect(response.status).toBe(200);
    expect(
      await flowModels.ensureRouteContent({
        parentId: routeUid,
        subKey: 'page',
        use: 'RootPageModel',
        uid: 'first-edit-root-page',
      }),
    ).toBe('first-edit-root-page');
    expect(
      await flowModels.ensureRouteContent({
        parentId: emptyTabUid,
        subKey: 'grid',
        use: 'BlockGridModel',
        uid: 'first-edit-empty-tab-grid',
      }),
    ).toBe('first-edit-empty-tab-grid');
    expect(
      await flowModels.ensureRouteContent({
        parentId: contentTabUid,
        subKey: 'grid',
        use: 'BlockGridModel',
        uid: 'must-not-replace-detached-grid',
      }),
    ).toBe(detachedGridUid);
    expect(
      await flowModels.findModelByParentId(contentTabUid, { subKey: 'grid', includeAsyncNode: true }),
    ).toMatchObject({
      uid: detachedGridUid,
      subModels: { items: [{ uid: detachedBlockUid }] },
    });
  }, 300000);

  it('reclaims a RootPageModel from an orphaned pre-rename RouteModel and repairs broken routes on startup scan', async () => {
    const routes = app.db.getRepository('desktopRoutes');
    const flowModels = app.db.getRepository('flowModels') as FlowModelRepository;
    const oldRouteUid = 'legacy-pre-rename-uid';
    const renamedRouteUid = 'vpb-rpa-ops';
    const preRenamePageUid = 'pre-rename-root-page';
    const unvisitedEmptyUid = 'vpb-unvisited-empty';
    const nonDesktopSkipUid = 'vpb-non-desktop-skip';

    const route = await routes.create({
      values: {
        type: 'flowPage',
        title: 'Edited before legacy rename',
        schemaUid: oldRouteUid,
        uiLayouts: ['admin-layout-model'],
      },
    });
    const routeId = route.get('id') as string | number;
    await flowModels.upsertModel({
      uid: preRenamePageUid,
      parentId: oldRouteUid,
      subKey: 'page',
      subType: 'object',
      async: true,
      use: 'RootPageModel',
      props: { routeId: String(routeId) },
    });

    // Simulate legacy Rename Path updating desktopRoutes.schemaUid without moving RouteModel in flowModels.
    await routes.update({ filterByTk: routeId, values: { schemaUid: renamedRouteUid } });
    expect(await flowModels.model.findByPk(renamedRouteUid)).toBeNull();
    expect(await flowModels.model.findByPk(oldRouteUid)).not.toBeNull();

    const emptyRoute = await routes.create({
      values: {
        type: 'flowPage',
        title: 'Never persisted RootPageModel',
        schemaUid: unvisitedEmptyUid,
        uiLayouts: ['admin-layout-model'],
      },
    });
    expect(emptyRoute.get('schemaUid')).toBe(unvisitedEmptyUid);
    await flowModels.remove(unvisitedEmptyUid);

    await routes.create({
      values: {
        type: 'flowPage',
        title: 'Non-desktop route that startup scan must skip',
        schemaUid: nonDesktopSkipUid,
      },
    });
    await flowModels.remove(nonDesktopSkipUid);

    const repairedCount = await repairAllLegacyRouteContents(app.db);
    expect(repairedCount).toBeGreaterThanOrEqual(2);

    expect(await flowModels.model.findByPk(oldRouteUid)).toBeNull();
    expect(await flowModels.findModelNodeSnapshotById(preRenamePageUid)).toMatchObject({
      uid: preRenamePageUid,
      parentId: renamedRouteUid,
      subKey: 'page',
      async: true,
    });
    expect(
      await flowModels.ensureRouteContent({
        parentId: renamedRouteUid,
        subKey: 'page',
        use: 'RootPageModel',
        uid: 'must-not-replace-reclaimed-page',
      }),
    ).toBe(preRenamePageUid);
    expect(
      await flowModels.ensureRouteContent({
        parentId: unvisitedEmptyUid,
        subKey: 'page',
        use: 'RootPageModel',
        uid: 'first-edit-after-startup-repair',
      }),
    ).toBe('first-edit-after-startup-repair');
    expect(await flowModels.model.findByPk(nonDesktopSkipUid)).toBeNull();
  }, 300000);

  it('does not allow a path alias to collide with its own numeric route id', async () => {
    const routes = app.db.getRepository('desktopRoutes');
    const route = await routes.create({
      values: {
        type: 'flowPage',
        title: 'Numeric alias route',
        schemaUid: 'numeric-alias-route',
        uiLayouts: ['admin-layout-model'],
      },
    });
    const root = await app.db.getRepository('users').findOne({ filter: { 'roles.name': 'root' } });
    const rootAgent = await app.agent().login(root);

    const response = await rootAgent.post('/desktopRoutes:setPathAlias').send({
      values: { id: route.get('id'), pathAlias: String(route.get('id')) },
    });

    expect(response.status).toBe(409);
    expect(
      await app.db.getRepository('desktopRoutePathAliases').findOne({ filter: { desktopRouteId: route.get('id') } }),
    ).toBeNull();
  }, 300000);

  it('clears a stale alias from a V2 route without a desktop layout without trying to repair page content', async () => {
    const routes = app.db.getRepository('desktopRoutes');
    const flowModels = app.db.getRepository('flowModels') as FlowModelRepository;
    const routeUid = 'vpb-no-desktop-layout';
    const route = await routes.create({
      values: {
        type: 'flowPage',
        title: 'Route without a desktop layout',
        schemaUid: routeUid,
      },
    });
    await flowModels.remove(routeUid);
    await app.db.getRepository('desktopRoutePathAliases').create({
      values: { desktopRouteId: route.get('id'), pathAlias: 'stale-friendly-path' },
    });
    const root = await app.db.getRepository('users').findOne({ filter: { 'roles.name': 'root' } });
    const rootAgent = await app.agent().login(root);

    const response = await rootAgent.post('/desktopRoutes:setPathAlias').send({
      values: { id: route.get('id'), pathAlias: null },
    });

    expect(response.status).toBe(200);
    expect(
      await app.db.getRepository('desktopRoutePathAliases').findOne({ filter: { desktopRouteId: route.get('id') } }),
    ).toBeNull();
    expect(await flowModels.model.findByPk(routeUid)).toBeNull();
  }, 300000);

  it('rolls back the route and page paths when reconnecting the legacy page fails', async () => {
    const routes = app.db.getRepository('desktopRoutes');
    const flowModels = app.db.getRepository('flowModels') as FlowModelRepository;
    const routeUid = 'vpb-attach-failure';
    const pageUid = 'attach-failure-page';
    const route = await routes.create({
      values: {
        type: 'flowPage',
        title: 'Legacy page with failed attach',
        schemaUid: routeUid,
        uiLayouts: ['admin-layout-model'],
      },
    });
    const routeId = String(route.get('id'));
    await flowModels.remove(routeUid);
    await flowModels.upsertModel({ uid: pageUid, use: 'RootPageModel', props: { routeId } });
    const treePaths = app.db.getRepository('flowModelTreePath');
    await treePaths.destroy({ filter: { ancestor: pageUid, descendant: pageUid, depth: 0 } });
    const attach = vi.spyOn(flowModels, 'attach').mockRejectedValueOnce(new Error('Simulated attach failure'));
    const root = await app.db.getRepository('users').findOne({ filter: { 'roles.name': 'root' } });
    const rootAgent = await app.agent().login(root);

    const response = await rootAgent.post('/desktopRoutes:setPathAlias').send({
      values: { id: route.get('id'), pathAlias: 'attach-failure-friendly' },
    });
    attach.mockRestore();

    expect(response.status).toBe(500);
    expect(await flowModels.model.findByPk(routeUid)).toBeNull();
    expect(await flowModels.findModelNodeSnapshotById(pageUid)).toBeNull();
    expect(
      await app.db.getRepository('desktopRoutePathAliases').findOne({ filter: { desktopRouteId: route.get('id') } }),
    ).toBeNull();
  }, 300000);
});
