/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createMockServer, type MockServer } from '@nocobase/test';
import { resolve } from 'path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import Plugin from '../plugin';

// Generic collection reads do not need a live browser or background session sweeper.
vi.mock('../services/BrowserSessionService', () => ({ BrowserSessionService: class {} }));

let app: MockServer;
let reader: ReturnType<MockServer['agent']>;
let ownProfileId: string;
let otherProfileId: string;
let ownSessionId: string;
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
  // Class-based plugin fixtures do not infer the package's collection directory.
  await app.db.import({ directory: resolve(__dirname, '../collections') });
  for (const name of ['aiBrowserProfiles', 'aiBrowserSessions', 'aiBrowserTasks']) {
    await app.db.getCollection(name).sync();
  }
  await app.db.getRepository('roles').create({ values: { name: 'browser-reader', title: 'Reader' } });
  const user = await app.db
    .getRepository('users')
    .create({ values: { username: 'browser-reader', roles: ['browser-reader'] } });
  const otherUser = await app.db
    .getRepository('users')
    .create({ values: { username: 'browser-other', roles: ['browser-reader'] } });
  reader = await app.agent().login(user, 'browser-reader');
  const profiles = app.db.getRepository('aiBrowserProfiles');
  const ownProfile = await profiles.create({
    values: { ownerId: user.id, name: 'mine', cookies: [{ value: 'secret' }], localStorage: { token: 'hidden' } },
  });
  const otherProfile = await profiles.create({ values: { ownerId: otherUser.id, name: 'other' } });
  ownProfileId = ownProfile.get('id');
  otherProfileId = otherProfile.get('id');
  const sessions = app.db.getRepository('aiBrowserSessions');
  const ownSession = await sessions.create({ values: { ownerId: user.id, profileId: ownProfileId, title: 'mine' } });
  const otherSession = await sessions.create({
    values: { ownerId: otherUser.id, profileId: otherProfileId, title: 'other' },
  });
  ownSessionId = ownSession.get('id');
  const tasks = app.db.getRepository('aiBrowserTasks');
  await tasks.create({ values: { sessionId: ownSessionId } });
  await tasks.create({ values: { sessionId: otherSession.get('id') } });
}, 120000);

afterAll(async () => {
  await app?.destroy();
});

it('scopes profile list/get and omits stored auth state over HTTP', async () => {
  const response = await reader
    .resource('aiBrowserProfiles')
    .list({ fields: ['id', 'name', 'cookies', 'localStorage'], appends: ['owner'] });
  expect(response.status).toBe(200);
  expect(response.body.data).toEqual([expect.objectContaining({ id: ownProfileId, name: 'mine' })]);
  expect(response.body.data[0]).not.toHaveProperty('cookies');
  expect(response.body.data[0]).not.toHaveProperty('localStorage');
  expect(response.body.data[0]).not.toHaveProperty('owner');
  const forbidden = await reader.resource('aiBrowserProfiles').get({ filterByTk: otherProfileId });
  expect(forbidden.status).toBe(200);
  expect(forbidden.body.data).toBeNull();
});

it('scopes sessions and related tasks without allowing profile expansion', async () => {
  const response = await reader.resource('aiBrowserSessions').list({ appends: ['profile'] });
  expect(response.status).toBe(200);
  expect(response.body.data).toHaveLength(1);
  expect(response.body.data[0].id).toBe(ownSessionId);
  expect(response.body.data[0]).not.toHaveProperty('profile');
  const tasks = await reader.resource('aiBrowserTasks').list({ appends: ['session.profile'] });
  expect(tasks.status).toBe(200);
  expect(tasks.body.data).toHaveLength(1);
  expect(tasks.body.data[0].sessionId).toBe(ownSessionId);
  expect(tasks.body.data[0]).not.toHaveProperty('session');
});
