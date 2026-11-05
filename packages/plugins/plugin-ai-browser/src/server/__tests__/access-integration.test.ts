/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createMockServer, type MockServer } from '@nocobase/test';
import { DefaultToolsManager } from '@nocobase/ai';
import type { Context } from '@nocobase/actions';
import { DataTypes } from '@nocobase/database';
import { resolve } from 'path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import Plugin from '../plugin';
import { BrowserSessionService } from '../services/BrowserSessionService';
import EnsureConfigKey from '../migrations/20261105000000-config-key';
import { getActiveBrowserSession } from '../tools/utils';

vi.spyOn(
  BrowserSessionService.prototype as unknown as { startZombieSweeper(): void },
  'startZombieSweeper',
).mockImplementation(() => {});
let app: MockServer;
let reader: ReturnType<MockServer['agent']>;
let plugin: Plugin;
let ctx: Context;
let ownId: string;
let otherId: string;
let ownCacheId: string;
let otherCacheId: string;
let userId: number;
const toolsManager = new DefaultToolsManager();

beforeAll(async () => {
  app = await createMockServer({
    acl: true,
    plugins: [
      'field-sort',
      'system-settings',
      'users',
      'auth',
      'acl',
      'data-source-manager',
      'data-source-main',
      'error-handler',
      [Plugin, { name: 'plugin-ai-browser' }],
    ],
  });
  await app.db.import({ directory: resolve(__dirname, '../collections') });
  for (const name of [
    'aiBrowserConfig',
    'aiBrowserProfiles',
    'aiBrowserSessions',
    'aiBrowserTasks',
    'aiBrowserActionEvents',
    'aiBrowserWorkflowCaches',
    'aiBrowserCachedSteps',
    'aiBrowserElementFingerprints',
  ]) {
    await app.db.getCollection(name).sync();
  }
  await app.db.getRepository('roles').create({ values: { name: 'browser-tool-reader', title: 'Reader' } });
  const user = await app.db
    .getRepository('users')
    .create({ values: { username: 'browser-tool-reader', roles: ['browser-tool-reader'] } });
  const other = await app.db.getRepository('users').create({ values: { username: 'browser-tool-other' } });
  userId = user.get('id');
  const conversations = app.db.collection({
    name: 'aiConversations',
    fields: [
      { name: 'sessionId', type: 'string' },
      { name: 'userId', type: 'integer' },
    ],
  });
  await conversations.sync();
  await conversations.repository.create({ values: { sessionId: 'my-conversation', userId } });
  await conversations.repository.create({ values: { sessionId: 'other-conversation', userId: other.get('id') } });
  reader = await app.agent().login(user, 'browser-tool-reader');
  plugin = app.pm.get<Plugin>('plugin-ai-browser');
  Object.assign(app, { aiManager: { toolsManager } });
  (plugin as unknown as { registerAITools(): void }).registerAITools();
  ctx = {
    app,
    db: app.db,
    state: { currentUser: { id: userId }, currentRoles: ['browser-tool-reader'] },
    t: (key: string) => key,
  } as unknown as Context;
  const sessions = app.db.getRepository('aiBrowserSessions');
  ownId = (
    await sessions.create({
      values: {
        ownerId: userId,
        status: 'running',
        conversationId: 'my-conversation',
        externalSessionId: 'own-driver',
        currentUrl: 'https://example.com/own',
        liveUrl: 'https://fixture.invalid/?token=SECRET&id=own-session',
        metadata: { driver: { debugUrl: 'wss://fixture.invalid?token=SECRET' } },
      },
    })
  ).get('id');
  otherId = (
    await sessions.create({
      values: {
        ownerId: other.get('id'),
        status: 'running',
        conversationId: 'other-conversation',
        externalSessionId: 'other-driver',
        currentUrl: 'https://example.com/private',
      },
    })
  ).get('id');
  const caches = app.db.getRepository('aiBrowserWorkflowCaches');
  ownCacheId = (
    await caches.create({ values: { ownerId: userId, enabled: true, name: 'Own cache', domain: 'example.com' } })
  ).get('id');
  otherCacheId = (
    await caches.create({
      values: { ownerId: other.get('id'), enabled: true, name: 'Private cache', domain: 'example.com', confidence: 1 },
    })
  ).get('id');
  for (const id of [ownCacheId, otherCacheId]) {
    await app.db
      .getRepository('aiBrowserCachedSteps')
      .create({ values: { workflowCacheId: id, order: 1, actionType: 'click', targetKey: id, enabled: true } });
  }
  for (const id of [ownId, otherId]) {
    await app.db
      .getRepository('aiBrowserActionEvents')
      .create({ values: { sessionId: id, description: id === ownId ? 'own artifact' : 'private artifact' } });
  }
  vi.spyOn(plugin.driver, 'healthCheck').mockResolvedValue(true);
  vi.spyOn(plugin.driver, 'ensureSession').mockResolvedValue({ externalSessionId: 'own-driver', status: 'running' });
  vi.spyOn(plugin.driver, 'stopSession').mockResolvedValue(undefined);
  vi.spyOn(plugin.driver, 'click').mockResolvedValue(undefined);
  vi.spyOn(plugin.driver, 'getCurrentUrl').mockResolvedValue('https://example.com/own');
  vi.spyOn(plugin.driver, 'takeScreenshot').mockResolvedValue(null);
  vi.spyOn(plugin.driver, 'extractDOM').mockResolvedValue('Own page');
}, 120000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await app?.destroy();
});

async function invoke(name: string, params: Record<string, unknown>, context = ctx) {
  const tool = await toolsManager.getTools(`browser_${name}`);
  return tool.invoke(context, params, undefined);
}

it('returns health without backend endpoints or credentials over HTTP', async () => {
  vi.stubEnv('AI_BROWSER_CDP_URL', 'wss://fixture.invalid?token=SECRET');
  vi.stubEnv('AI_BROWSER_LIVE_URL', 'https://fixture.invalid?token=OTHER_SECRET');
  const response = await reader.resource('aiBrowser').getDriverStatus();
  expect(response.status).toBe(200);
  expect(response.body.data).toEqual({ available: true, driver: plugin.driver.name });
  const session = await reader.resource('aiBrowserSessions').get({ filterByTk: ownId, fields: ['id', 'metadata'] });
  expect(session.body.data).not.toHaveProperty('metadata');
  const stored = await reader.resource('aiBrowserSessions').get({ filterByTk: ownId });
  expect(stored.body.data.liveUrl).toBeNull();
  const tool = await invoke('get_session', { sessionId: ownId });
  expect(tool.content).not.toContain('SECRET');
});

it.each(['get_session', 'stop_session', 'get_artifacts'])(
  'denies foreign records through the registered %s tool',
  async (name) => {
    const result = await invoke(name, { sessionId: otherId });
    expect(result.status).toBe('error');
    expect(result.content).not.toContain('private');
    expect(plugin.driver.stopSession).not.toHaveBeenCalled();
    expect((await app.db.getRepository('aiBrowserSessions').findById(otherId)).get('status')).toBe('running');
  },
);

it('reads owner records, rejects anonymous calls and scopes conversation lookup', async () => {
  expect((await invoke('get_session', { sessionId: ownId })).content).toContain('/own');
  expect((await invoke('get_artifacts', { sessionId: ownId })).content).toContain('own artifact');
  const anonymous = { ...ctx, state: {} } as Context;
  expect((await invoke('list_sessions', {}, anonymous)).status).toBe('error');
  expect((await invoke('get_session', { sessionId: ownId }, anonymous)).status).toBe('error');
  await expect(getActiveBrowserSession(plugin, ctx, 'other-conversation')).rejects.toThrow('No active browser session');
  expect(plugin.driver.ensureSession).not.toHaveBeenCalled();
  const list = await invoke('list_sessions', {});
  expect(list.content).toContain(ownId);
  expect(list.content).not.toContain(otherId);
});

it.each(['open_url', 'read_page', 'click_element', 'input_text', 'scroll', 'run_cached_workflow'])(
  'rejects a foreign conversation in the registered %s tool before restoring its browser',
  async (name) => {
    const result = await invoke(name, { conversationId: 'other-conversation', url: 'https://example.com' });
    expect(result.status).toBe('error');
    expect(plugin.driver.ensureSession).not.toHaveBeenCalled();
  },
);

it('does not include backend connection metadata when preparing an owner session', async () => {
  const result = await reader.resource('aiBrowser').prepareSession({ values: { conversationId: 'my-conversation' } });
  expect(result.status).toBe(200);
  expect(result.body.data.id).toBe(ownId);
  expect(result.body.data.metadata).not.toHaveProperty('driver');
  expect(JSON.stringify(result.body)).not.toContain('SECRET');
});

it('checks ownership for explicit and automatically selected caches', async () => {
  const foreign = await invoke('run_cached_workflow', { conversationId: 'my-conversation', cacheId: otherCacheId });
  expect(foreign.status).toBe('error');
  expect(plugin.driver.click).not.toHaveBeenCalled();
  const own = await invoke('run_cached_workflow', { conversationId: 'my-conversation' });
  expect(own.status).toBe('success');
  expect(plugin.driver.click).toHaveBeenCalledWith('own-driver', ownCacheId);
  expect(plugin.driver.click).not.toHaveBeenCalledWith('own-driver', otherCacheId);
});

it('allows the owner to stop their session and an administrator to inspect another owner', async () => {
  expect((await invoke('stop_session', { sessionId: ownId })).status).toBe('success');
  expect(plugin.driver.stopSession).toHaveBeenCalledWith('own-driver');
  app.acl.define({ role: 'browser-tool-admin' }).snippets.add('pm.ai-browser');
  const adminCtx = { ...ctx, state: { ...ctx.state, currentRoles: ['browser-tool-admin'] } } as Context;
  expect((await invoke('get_session', { sessionId: otherId }, adminCtx)).content).toContain('/private');
  expect((await invoke('stop_session', { sessionId: otherId }, adminCtx)).status).toBe('success');
});

it('supports fresh config sync and updates by key', async () => {
  app.acl.define({ role: 'browser-tool-reader' }).snippets.add('pm.ai-browser');
  for (const value of ['first', 'updated']) {
    const response = await reader.resource('aiBrowser').setConfig({ values: { key: 'fixture', value } });
    expect(response.status).toBe(200);
  }
  const rows = await app.db.getRepository('aiBrowserConfig').find();
  expect(rows).toHaveLength(1);
  expect(rows[0].get('value')).toBe('updated');
  expect(rows[0].get('id')).toBeDefined();
});

it.each([false, true])(
  'upgrades and syncs legacy config without losing ids or values (composite key = %s)',
  async (composite) => {
    const collection = app.db.getCollection('aiBrowserConfig');
    const table = collection.getTableNameWithSchema();
    const qi = app.db.sequelize.getQueryInterface();
    await qi.dropTable(table);
    await qi.createTable(table, {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: !composite },
      key: { type: DataTypes.STRING, primaryKey: composite },
      value: { type: DataTypes.TEXT },
      createdAt: { type: DataTypes.DATE },
      updatedAt: { type: DataTypes.DATE },
    });
    await qi.bulkInsert(table, [
      { id: 1, key: 'fixture', value: 'preserved', createdAt: new Date(), updatedAt: new Date() },
    ]);
    const migration = new EnsureConfigKey({ db: app.db, queryInterface: qi, sequelize: app.db.sequelize });
    await migration.up();
    await migration.up();
    await collection.sync();
    const [rows] = await app.db.sequelize.query(`SELECT * FROM ${collection.quotedTableName()}`);
    expect(rows).toEqual([expect.objectContaining({ id: 1, key: 'fixture', value: 'preserved' })]);
    await collection.repository.update({ filter: { key: 'fixture' }, values: { value: 'updated after migration' } });
    expect((await collection.repository.findById(1)).get('value')).toBe('updated after migration');
    await collection.repository.create({ values: { key: 'new-key', value: 'new value' } });
    expect(await collection.repository.count()).toBe(2);
    await expect(qi.bulkInsert(table, [{ id: 2, key: 'fixture', value: 'duplicate' }])).rejects.toThrow();
  },
);

it('preserves legacy data when duplicate configuration keys prevent migration', async () => {
  const collection = app.db.getCollection('aiBrowserConfig');
  const table = collection.getTableNameWithSchema();
  const qi = app.db.sequelize.getQueryInterface();
  await qi.dropTable(table);
  await qi.createTable(table, {
    id: { type: DataTypes.INTEGER, primaryKey: true },
    key: { type: DataTypes.STRING, primaryKey: true },
    value: { type: DataTypes.TEXT },
  });
  const values = [
    { id: 1, key: 'duplicate', value: 'first' },
    { id: 2, key: 'duplicate', value: 'second' },
  ];
  await qi.bulkInsert(table, values);
  const migration = new EnsureConfigKey({ db: app.db, queryInterface: qi, sequelize: app.db.sequelize });
  await expect(migration.up()).rejects.toThrow();
  const [rows] = await app.db.sequelize.query(`SELECT * FROM ${collection.quotedTableName()} ORDER BY id`);
  expect(rows).toEqual(values);
});
