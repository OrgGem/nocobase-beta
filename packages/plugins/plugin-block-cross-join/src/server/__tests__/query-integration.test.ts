/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createMockServer, type MockServer } from '@nocobase/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import Plugin from '../plugin';

let app: MockServer;
let reader: ReturnType<MockServer['agent']>;
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
      [Plugin, { name: 'plugin-block-cross-join' }],
    ],
  });
  const collection = app.db.collection({
    name: 'joinDocuments',
    fields: [
      { name: 'ownerId', type: 'integer' },
      { name: 'title', type: 'string' },
      { name: 'secret', type: 'string' },
    ],
  });
  await collection.sync();
  await app.db.getRepository('roles').create({ values: { name: 'join-reader', title: 'Reader' } });
  const user = await app.db
    .getRepository('users')
    .create({ values: { username: 'join-reader', roles: ['join-reader'] } });
  await collection.repository.create({ values: { ownerId: user.id, title: 'mine', secret: 'hidden' } });
  await collection.repository.create({ values: { ownerId: 999, title: 'other', secret: 'hidden' } });
  reader = await app.agent().login(user, 'join-reader');
  app.acl.define({
    role: 'join-reader',
    actions: { 'joinDocuments:list': { fields: ['id', 'title'], filter: { ownerId: user.id } } },
  });
}, 120000);
afterAll(async () => {
  await app?.destroy();
});

it('returns only authorized rows and fields through the real HTTP action', async () => {
  const response = await reader
    .resource('crossJoin')
    .query({ values: { config: { primarySource: { dataSource: 'main', collection: 'joinDocuments' } } } });
  expect(response.status).toBe(200);
  expect(response.body.data).toHaveLength(1);
  expect(response.body.data[0]).toMatchObject({ 'primary.id': expect.any(Number), 'primary.title': 'mine' });
  expect(Object.keys(response.body.data[0])).not.toContain('primary.secret');
  expect(response.body.meta.count).toBe(1);
});

it('denies ungranted collections and restricted columns over HTTP', async () => {
  const forbidden = await reader
    .resource('crossJoin')
    .query({ values: { config: { primarySource: { dataSource: 'main', collection: 'users' } } } });
  expect(forbidden.status).toBe(403);
  const secret = await reader.resource('crossJoin').query({
    values: {
      config: {
        primarySource: { dataSource: 'main', collection: 'joinDocuments' },
        columns: [{ source: 0, field: 'secret' }],
      },
    },
  });
  expect(secret.status).toBe(403);
});
